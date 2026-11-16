import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportFileSchema, exportSchema, type CaseSummarizer, type CaseSummaryExportInput, type GraphNode } from '@neburyx/contracts';
import { renderForExport, sealToken } from '@neburyx/ee-ask';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_IDENTITY } from '../testing/app-store.js';
import { principalFixture } from '../testing/principal-fixture.js';
import { createExportService } from './export-service.js';
import type { ShownReader } from './shown-reader.js';
import { el, exportWebRoot, startExportRig, type ExportRig } from '../testing/export-rig.js';

afterAll(() => rmSync(exportWebRoot, { recursive: true, force: true }));

const keys = { current: { kid: 'abcd1234', bytes: Buffer.alloc(32, 9) } };
const W1 = el('widget', 'W-1');
const W2 = el('widget', 'W-2');
const ME = LOCAL_IDENTITY.principal.id;
const RUN = '0192f000-0000-7000-8000-0000000000aa';

/** The real renderer of the extension with a sealing key of the test's own. */
const summarizer = (options: { readonly available?: boolean } = {}): CaseSummarizer => ({
  maxElements: 300,
  availability: () => (options.available === false ? { available: false, reason: 'off' } : { available: true }),
  summarize: async () => ({ status: 'timeLimit', calls: 1 }),
  renderForExport: (input: CaseSummaryExportInput) => renderForExport(keys, input, Date.now()),
});

function tokenOf(investigationId: string, over: { readonly now?: number; readonly policyVersion?: string; readonly generatedBy?: string; readonly sentences?: { text: string; cites: string[] }[] } = {}): string {
  return sealToken(
    keys,
    {
      investigationId,
      generatedBy: over.generatedBy ?? ME,
      policyVersion: over.policyVersion ?? 'none',
      modelRef: 'claude-sonnet-5-5',
      promptId: 'case-summary',
      promptVersion: '1',
      sentences: over.sentences ?? [{ text: 'Widget one is linked to widget two.', cites: ['n1', 'n2'] }, { text: 'Widget two is listed.', cites: ['n2'] }],
      inputRefs: [{ key: 'n1', kind: 'entity', ref: W1 }, { key: 'n2', kind: 'entity', ref: W2 }],
      propertyValuesSent: false,
      runId: RUN,
      mask: false,
      wordListVersion: 1,
      templates: [{ storable: false, reason: 'unlisted-word' }, { storable: false, reason: 'unlisted-word' }],
    },
    over.now ?? Date.now(),
  );
}

const two = { kind: 'view', format: 'json', entities: [W1, W2] };
const fileOf = async (rig: ExportRig, response: { json(): unknown }) => {
  const record = exportSchema.parse(response.json());
  const bytes = (await rig.download(record.id)).rawPayload;
  return JSON.parse(bytes.toString('utf8')) as unknown;
};

async function rigOf(options: { readonly previewOn?: boolean; readonly available?: boolean; readonly widgets?: string[]; readonly policyVersion?: () => string } = {}) {
  const rig = await startExportRig({ extension: { name: 'summary', routeGroups: [] }, previewOn: options.previewOn ?? true, caseSummarizer: summarizer(options.available === undefined ? {} : { available: options.available }), widgets: options.widgets ?? ['W-1', 'W-2'], ...(options.policyVersion === undefined ? {} : { policyVersion: options.policyVersion }) });
  const investigation = await rig.open();
  return { rig, id: investigation.id };
}

describe('an export that includes the AI case summary', () => {
  it('holds the labelled summary in a JSON file, with the model, the two-part coverage and cites that are the refs of elements of the same file', async () => {
    const { rig, id } = await rigOf();
    const response = await rig.create(id, { ...two, summaryToken: tokenOf(id) });
    expect(response.statusCode).toBe(201);
    const file = exportFileSchema.parse(await fileOf(rig, response));
    expect(file.summary).toMatchObject({ label: 'AI-drafted', model: 'claude-sonnet-5-5' });
    expect(file.summary?.sentences.map((sentence) => sentence.text)).toEqual(['Widget one is linked to widget two.', 'Widget two is listed.']);
    expect(file.summary?.coverage.summary).toBe('The draft cites 2 of the 2 shown elements.');
    expect(file.summary?.coverage.retrieval).toMatch(/^2 shown/u);
    const refs = new Set(file.entities.map((node) => JSON.stringify(node.ref)));
    for (const sentence of file.summary?.sentences ?? []) for (const cite of sentence.cites) expect(refs.has(JSON.stringify(cite.ref))).toBe(true);
    await rig.stop();
  });

  it('holds no summary key in a file made without a token', async () => {
    const { rig, id } = await rigOf();
    const response = await rig.create(id, two);
    expect(Object.keys((await fileOf(rig, response)) as object)).toEqual(['header', 'entities', 'relationships']);
    await rig.stop();
  });

  it('refuses every token that cannot be used as one answer, with no export row and no file', async () => {
    const cases: readonly [string, (id: string) => string, Parameters<typeof rigOf>[0]?][] = [
      ['an expired token', (id) => tokenOf(id, { now: Date.now() - 31 * 60_000 }), undefined],
      ['a token of another person', (id) => tokenOf(id, { generatedBy: 'someone-else' }), undefined],
      ['a token of another investigation', () => tokenOf('0192f000-0000-7000-8000-0000000000c9'), undefined],
      ['a token sealed under another policy version', (id) => tokenOf(id, { policyVersion: 'p0' }), undefined],
      ['an unreadable token', () => 'not-a-token', undefined],
      ['a token with summaries not available', (id) => tokenOf(id), { available: false }],
      ['a token with the AI preview off', (id) => tokenOf(id), { previewOn: false }],
    ];
    for (const [name, token, options] of cases) {
      const { rig, id } = await rigOf(options ?? {});
      const response = await rig.create(id, { ...two, summaryToken: token(id) });
      expect(response.statusCode, name).toBe(403);
      expect(response.json(), name).toMatchObject({ error: { code: 'ACCESS_DENIED', details: { reason: 'summary-refused' } } });
      expect(Object.keys((response.json() as { error: { details: object } }).error.details), name).toEqual(['reason']);
      expect(JSON.stringify(response.json()), name).not.toMatch(/token|expired|policy|preview|available|another/iu);
      expect(rig.store.exports.rows, name).toHaveLength(0);
      await rig.stop();
    }
  });

  it('refuses a token sent for a picture as INVALID_REQUEST', async () => {
    const { rig, id } = await rigOf();
    const response = await rig.create(id, { kind: 'view', format: 'png', entities: [W1], summaryToken: tokenOf(id) });
    expect(response.statusCode).toBe(400);
    await rig.stop();
  });

  it('drops a sentence that cites an element the export does not hold, without a message, and keeps the others', async () => {
    const { rig, id } = await rigOf({ widgets: ['W-1'] });
    const only = { kind: 'view', format: 'json', entities: [W1] };
    const kept = exportFileSchema.parse(await fileOf(rig, await rig.create(id, { ...only, summaryToken: tokenOf(id, { sentences: [{ text: 'Widget one is listed.', cites: ['n1'] }, { text: 'Widget two is listed.', cites: ['n2'] }] }) })));
    expect(kept.summary?.sentences.map((sentence) => sentence.text)).toEqual(['Widget one is listed.']);
    expect(kept.summary?.coverage.summary).toBe('The draft cites 1 of the 1 shown elements.');
    const none = exportFileSchema.parse(await fileOf(rig, await rig.create(id, { ...only, summaryToken: tokenOf(id) })));
    expect(none.summary?.sentences).toEqual([]);
    expect(none.summary?.coverage.summary).toBe('No sentence was kept.');
    await rig.stop();
  });
});

const unzipped = (bytes: Buffer): { readonly names: string[]; readonly read: (name: string) => string } => {
  const folder = mkdtempSync(join(tmpdir(), 'nbx-summary-zip-'));
  const path = join(folder, 'x.zip');
  writeFileSync(path, bytes);
  const names = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).trim().split('\n');
  return { names, read: (name) => execFileSync('unzip', ['-p', path, name], { encoding: 'utf8' }) };
};

describe('the summary in a CSV export, the absence everywhere else, the audit and the replay', () => {
  it('adds summary.csv to the zip with header lines, a guarded sentence cell and cites that name rows of the entities file', async () => {
    const { rig, id } = await rigOf();
    const token = tokenOf(id, { sentences: [{ text: '=Widget one is listed.', cites: ['n1'] }, { text: '@Widget two is listed.', cites: ['n2', 'n1'] }] });
    const response = await rig.create(id, { kind: 'view', format: 'csv', entities: [W1, W2], summaryToken: token });
    expect(response.statusCode).toBe(201);
    const zip = unzipped((await rig.download(exportSchema.parse(response.json()).id)).rawPayload);
    expect(zip.names).toEqual(['entities.csv', 'relationships.csv', 'summary.csv']);
    const summary = zip.read('summary.csv');
    expect(summary).toContain('# AI-drafted');
    expect(summary).toContain('# model: claude-sonnet-5-5');
    expect(summary).toMatch(/# coverage: The draft cites 2 of the 2 shown elements\./u);
    expect(summary).toContain('"\'=Widget one is listed."');
    expect(summary).toContain('"\'@Widget two is listed.","entity:widget:W-2;entity:widget:W-1"');
    const entities = zip.read('entities.csv');
    for (const cite of ['W-1', 'W-2']) expect(entities).toContain(`"widget","${cite}"`);
    await rig.stop();
  });

  it('writes an id that holds a colon or a semicolon percent-encoded, so a cite is never read as two', async () => {
    const odd = el('widget', 'W:1;x%');
    const { rig, id } = await rigOf({ widgets: ['W-1', 'W:1;x%'] });
    const token = sealToken(keys, { investigationId: id, generatedBy: ME, policyVersion: 'none', modelRef: 'm', promptId: 'case-summary', promptVersion: '1', sentences: [{ text: 'Widget one is listed.', cites: ['n1'] }], inputRefs: [{ key: 'n1', kind: 'entity', ref: odd }], propertyValuesSent: false, runId: RUN, mask: false, wordListVersion: 1, templates: [{ storable: false, reason: 'unlisted-word' }] }, Date.now());
    const response = await rig.create(id, { kind: 'view', format: 'csv', entities: [odd], summaryToken: token });
    expect(response.json()).toMatchObject({ status: 'ready' });
    const zip = unzipped((await rig.download(exportSchema.parse(response.json()).id)).rawPayload);
    expect(zip.read('summary.csv')).toContain('entity:widget:W%3A1%3Bx%25');
    expect(zip.read('entities.csv')).toContain('"W:1;x%"');
    await rig.stop();
  });

  it('carries no summary text, key or file name in any format when no token was sent, and a picture refuses one', async () => {
    const { rig, id } = await rigOf();
    const json = JSON.stringify(await fileOf(rig, await rig.create(id, two)));
    expect(json).not.toMatch(/summary|AI-drafted/u);
    const csv = await rig.create(id, { kind: 'view', format: 'csv', entities: [W1, W2] });
    const zip = unzipped((await rig.download(exportSchema.parse(csv.json()).id)).rawPayload);
    expect(zip.names).toEqual(['entities.csv', 'relationships.csv']);
    for (const name of zip.names) expect(zip.read(name)).not.toMatch(/AI-drafted|summary/u);
    const png = await rig.create(id, { kind: 'view', format: 'png', entities: [W1, W2] });
    expect(png.statusCode).toBe(201);
    expect(JSON.stringify(png.json())).not.toMatch(/summary|AI-drafted/u);
    await rig.stop();
  });

  it('audits an export with a summary with the run id and the counts, never a sentence, and a refused token as refused without it', async () => {
    const { rig, id } = await rigOf();
    const token = tokenOf(id);
    await rig.create(id, { ...two, summaryToken: token });
    await rig.create(id, { ...two, summaryToken: tokenOf(id, { generatedBy: 'someone-else' }) });
    const events = rig.events.filter((event) => event.action === 'export.create');
    expect(events).toEqual([
      expect.objectContaining({ result: 'success', detail: { export: { format: 'json', entities: 2, relationships: 0, maskedFields: 0, summary: { runId: RUN, kept: 2, dropped: 0 } } } }),
      expect.objectContaining({ result: 'refused', detail: { export: { format: 'json', refusal: 'summary-refused' } } }),
    ]);
    expect(JSON.stringify(rig.events)).not.toMatch(/Widget one|AI-drafted|summaryToken/u);
    await rig.stop();
  });

  it('answers a repeat of the same key and body from the stored result, and refuses another token under the same key as a reuse of the key', async () => {
    const { rig, id } = await rigOf();
    const key = rig.newKey();
    const body = { ...two, summaryToken: tokenOf(id) };
    const first = await rig.create(id, body, key);
    const again = await rig.create(id, body, key);
    expect(again.statusCode).toBe(first.statusCode);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(rig.store.exports.rows).toHaveLength(1);
    const other = await rig.create(id, { ...two, summaryToken: tokenOf(id, { sentences: [{ text: 'Widget one is listed.', cites: ['n1'] }] }) }, key);
    expect(other.statusCode).toBe(409);
    await rig.stop();
  });

  it('refuses a token sealed under the policy version of before a change', async () => {
    let version = 'none';
    const { rig, id } = await rigOf({ policyVersion: () => version });
    const token = tokenOf(id);
    version = 'p-changed';
    expect((await rig.create(id, { ...two, summaryToken: token })).statusCode).toBe(403);
    await rig.stop();
  });
});

describe('the summary of an export is never less masked than the file', () => {
  const reading = (value: string, masked: boolean): Awaited<ReturnType<ShownReader['read']>> => {
    const node: GraphNode = { ref: W1, display: { title: 'Ana Silva', type: 'widget' }, properties: [{ key: 'tier', value, dataClass: 'text', masked }], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } };
    return { nodes: [node], edges: [], omitted: false, unresolved: false, unresolvedCount: 0, maskedFields: masked ? 1 : 0, uncounted: 0, notRetrieved: { value: 0, quality: 'exact', scope: 'not yet retrieved' } };
  };

  async function exportWith(format: 'json' | 'csv', served: Awaited<ReturnType<ShownReader['read']>>) {
    const asked: unknown[] = [];
    const rig = await startExportRig();
    const opened = await rig.open();
    const service = createExportService({
      store: rig.store,
      files: rig.files,
      reader: { read: (call) => (asked.push(call), Promise.resolve(served)) },
      mapping: rig.mapping,
      access: { require: () => Promise.resolve(), admit: () => undefined, readable: () => Promise.resolve([]) },
      policy: { authorizeSource: () => Promise.resolve({ allowed: true }) },
      policyVersion: () => 'none',
      audit: { record: () => Promise.resolve() },
      logger: { warn: () => undefined },
      summarizer: () => summarizer(),
      previewOn: true,
    });
    const token = sealToken(keys, { investigationId: opened.id, generatedBy: principalFixture.id, policyVersion: 'none', modelRef: 'm', promptId: 'case-summary', promptVersion: '1', sentences: [{ text: 'Ana Silva has tier "gold".', cites: ['n1'] }, { text: 'Ana Silva is listed.', cites: ['n1'] }], inputRefs: [{ key: 'n1', kind: 'entity', ref: W1 }], propertyValuesSent: true, runId: RUN, mask: false, wordListVersion: 2, templates: [{ storable: false, reason: 'property-value' }, { storable: false, reason: 'unlisted-word' }] }, Date.now());
    const made = await service.create({ traceId: 't', principal: principalFixture, investigationId: opened.id, request: { kind: 'view', format, entities: [W1], edges: [], aggregates: [], derived: [], summaryToken: token } });
    const bytes = (await rig.download(('id' in made ? made.id : ''))).rawPayload;
    await rig.stop();
    return { asked, bytes };
  }

  it.each(['json', 'csv'] as const)('reads a %s export with no mask, and drops a sentence that states a value the policy masks, in the file and in its summary', async (format) => {
    const masked = await exportWith(format, reading('g•••', true));
    expect(masked.asked).toHaveLength(1);
    expect(masked.asked[0]).not.toHaveProperty('mask');
    const text = format === 'json' ? masked.bytes.toString('utf8') : unzipped(masked.bytes).read('summary.csv');
    expect(text).not.toContain('gold');
    expect(text).toContain('Ana Silva is listed.');
    expect(text).not.toContain('has tier');
    const shown = await exportWith(format, reading('gold', false));
    const shownText = format === 'json' ? shown.bytes.toString('utf8') : unzipped(shown.bytes).read('summary.csv');
    expect(shownText).toContain('has tier');
  });
});
