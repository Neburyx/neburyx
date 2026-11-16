import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ExtensionRefusal, storedAiNotesEntrySchema, type AiNotesCapability, type AuditEvent, type CopyToNotesResponse, type ExtensionRequest } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createCopyToNotesRoute } from './copy-route.js';
import type { NotesTemplate } from './notes-convert.js';
import { sealToken, TOKEN_LIFETIME_MS, type SealInput } from './token.js';
import type { TokenKeys } from './token-keys.js';

const KEYS: TokenKeys = { current: { kid: 'cur00001', bytes: Buffer.alloc(32, 1) }, previous: undefined };
const ME = 'person-1';
const INVESTIGATION = '0192f000-0000-7000-8000-0000000000c1';
const RUN = '0192f000-0000-7000-8000-0000000000aa';
const NOW = 1_800_000_000_000;
const SAVE = { state: 'unsaved', savedAt: null } as const;

const plain = (text: string): NotesTemplate => ({ storable: true, text, placeholders: [] });
const refused = (): NotesTemplate => ({ storable: false, reason: 'unlisted-word' });

function input(over: Partial<SealInput> = {}): SealInput {
  return {
    investigationId: INVESTIGATION,
    generatedBy: ME,
    policyVersion: 'p1',
    modelRef: 'claude-sonnet-5-5',
    promptId: 'case-summary',
    promptVersion: '1',
    sentences: [
      { text: 'The record is linked to the same source.', cites: ['n1'] },
      { text: 'The record names Weldinum.', cites: ['n1'] },
    ],
    inputRefs: [{ key: 'n1', kind: 'entity', ref: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' } }],
    propertyValuesSent: false,
    runId: RUN,
    mask: false,
    wordListVersion: 1,
    templates: [plain('The record is linked to the same source.'), refused()],
    ...over,
  };
}

interface Rig {
  readonly appended: Parameters<AiNotesCapability['append']>[0][];
  readonly events: AuditEvent[];
  request(token: string, over?: Partial<ExtensionRequest>, version?: number): ExtensionRequest;
}

function rig(options: { readonly stored?: Set<string>; readonly failAppend?: unknown; readonly failAudit?: boolean; readonly failCanWrite?: unknown } = {}): Rig {
  const appended: Parameters<AiNotesCapability['append']>[0][] = [];
  const events: AuditEvent[] = [];
  const stored = options.stored ?? new Set<string>();
  let version = 1;
  const aiNotes: AiNotesCapability = {
    async append(call) {
      if (options.failAppend !== undefined) throw options.failAppend;
      if (stored.has(call.entry.tokenId)) return { outcome: 'already-stored', version, save: SAVE };
      appended.push(call);
      stored.add(call.entry.tokenId);
      version += 1;
      return { outcome: 'appended', version, save: SAVE };
    },
    async canWrite() {
      if (options.failCanWrite !== undefined) throw options.failCanWrite;
    },
    async read() {
      return { entries: [], version, save: SAVE };
    },
  };
  return {
    appended,
    events,
    request: (token, over = {}, bodyVersion = 1) => ({
      principalId: ME,
      principalRole: 'investigator',
      previewOn: true,
      traceId: 'tr-1',
      audit: { record: async (event) => (options.failAudit === true ? Promise.reject(new Error('down')) : void events.push(event)) },
      body: { summaryToken: token, version: bodyVersion },
      askClassifier: { availability: () => ({ available: false, reason: 'x' }), classify: async () => ({ status: 'failed' }) } as never,
      caseSummarizer: { maxElements: 300, availability: () => ({ available: true }), summarize: async () => ({ status: 'timeLimit', calls: 1 }) },
      policyVersion: () => 'p1',
      signal: new AbortController().signal,
      investigation: { id: INVESTIGATION, sourceId: 'demo' },
      aiNotes,
      ...over,
    }),
  };
}

const route = createCopyToNotesRoute({ tokenKeys: () => KEYS });
const call = (request: ExtensionRequest): Promise<unknown> => route.handler(request);
const sealed = (over: Partial<SealInput> = {}, at = Date.now()): string => sealToken(KEYS, input(over), at);

describe('copy to notes', () => {
  it('stores the sentences the token says are storable, with what the entry needs, and answers the counts, version and save state', async () => {
    const h = rig();
    const answer = (await call(h.request(sealed()))) as CopyToNotesResponse;
    expect(answer).toEqual({ copied: 1, notCopied: 1, alreadyCopied: false, version: 2, save: SAVE });
    const [only] = h.appended;
    expect(only).toMatchObject({ investigationId: INVESTIGATION, expectedVersion: 1, maxRefs: 300 });
    expect(only?.entry).toMatchObject({ generatedBy: ME, modelRef: 'claude-sonnet-5-5', promptId: 'case-summary', promptVersion: '1', wordListVersion: 1, label: 'AI-drafted', sentences: [{ text: 'The record is linked to the same source.', placeholders: [], cites: [{ key: 'n1', kind: 'entity' }] }] });
    expect(only?.entry.inputRefs).toHaveLength(1);
    expect(JSON.stringify(only?.entry)).not.toContain('Weldinum');
  });

  it('stores a sentence whose model repeated one cite 51 times with that cite once, so the entry reads back', async () => {
    const h = rig();
    const repeated = Array.from({ length: 51 }, () => 'n1');
    await call(h.request(sealed({ sentences: [{ text: 'The record is linked to the same source.', cites: repeated }, { text: 'The record names Weldinum.', cites: ['n1'] }] })));
    const [only] = h.appended;
    const entry = storedAiNotesEntrySchema.parse(only?.entry);
    expect(entry.sentences[0]?.cites).toHaveLength(1);
  });

  it('answers a second copy of the same token as already copied and stores nothing, with the current version and save state', async () => {
    const h = rig();
    const token = sealed();
    await call(h.request(token));
    const again = await call(h.request(token, {}, 1));
    expect(again).toEqual({ copied: 0, notCopied: 0, alreadyCopied: true, version: 2, save: SAVE });
    expect(h.appended).toHaveLength(1);
  });

  it('stores nothing when no sentence is storable and answers the version and save state as they are', async () => {
    const h = rig();
    const answer = await call(h.request(sealed({ templates: [refused(), refused()] })));
    expect(answer).toEqual({ copied: 0, notCopied: 2, alreadyCopied: false, version: 1, save: SAVE });
    expect(h.appended).toEqual([]);
  });

  it('checks that the investigation may be written even when no sentence is storable, and refuses as a copy that stores does', async () => {
    const closed = rig({ failCanWrite: Object.assign(new Error('closed'), { code: 'CONFLICT' }) });
    await expect(call(closed.request(sealed({ templates: [refused(), refused()] })))).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    const gone = rig({ failCanWrite: Object.assign(new Error('gone'), { code: 'NOT_FOUND' }) });
    await expect(call(gone.request(sealed({ templates: [refused(), refused()] })))).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it('stores the storable sentences of a summary whose generation sent property values, and not the others', async () => {
    const h = rig();
    const answer = await call(h.request(sealed({ propertyValuesSent: true })));
    expect(answer).toMatchObject({ copied: 1, notCopied: 1 });
  });

  it.each([
    ['expired', () => sealed({}, Date.now() - TOKEN_LIFETIME_MS - 1)],
    ['another person\'s', () => sealed({ generatedBy: 'someone-else' })],
    ['for another investigation', () => sealed({ investigationId: '0192f000-0000-7000-8000-0000000000c2' })],
    ['from another policy version', () => sealed({ policyVersion: 'p0' })],
    ['under another word list version', () => sealed({ wordListVersion: 2 })],
    ['altered', () => `${sealed().slice(0, -3)}AAA`],
    ['not a token', () => 'nonsense'],
  ])('refuses a token that is %s with ACCESS_DENIED and stores nothing', async (_name, make) => {
    const h = rig();
    await expect(call(h.request(make()))).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(h.appended).toEqual([]);
  });

  it('refuses a viewer, an unavailable summary and a missing capability with ACCESS_DENIED', async () => {
    const h = rig();
    await expect(call(h.request(sealed(), { principalRole: 'viewer' }))).rejects.toBeInstanceOf(ExtensionRefusal);
    await expect(call(h.request(sealed(), { caseSummarizer: { maxElements: 300, availability: () => ({ available: false, reason: 'no' }), summarize: async () => ({ status: 'timeLimit', calls: 1 }) } }))).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    const { aiNotes: _gone, ...without } = h.request(sealed());
    await expect(call(without)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(h.appended).toEqual([]);
  });

  it.each([['NOT_FOUND'], ['CONFLICT'], ['ACCESS_DENIED']])('gives the refusal of the capability %s as ACCESS_DENIED', async (code) => {
    const h = rig({ failAppend: Object.assign(new Error(code), { code }) });
    await expect(call(h.request(sealed()))).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it.each([['CONFLICTED_VIEW_VERSION'], ['INVALID_REQUEST'], ['INTERNAL_ERROR']])('lets %s pass as the application gave it', async (code) => {
    const failure = Object.assign(new Error(code), { code });
    const h = rig({ failAppend: failure });
    await expect(call(h.request(sealed()))).rejects.toBe(failure);
  });

  it('writes an audit event with the run and the counts and no text, and fails closed when it cannot', async () => {
    const h = rig();
    await call(h.request(sealed()));
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ action: 'ai.case-summary.copied', result: 'success', sourceId: 'demo', detail: { notes: { runId: RUN, copied: 1, notCopied: 1, alreadyCopied: false } } });
    expect(JSON.stringify(h.events[0])).not.toContain('linked to the same');
    const down = rig({ failAudit: true });
    await expect(call(down.request(sealed()))).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
  });

  it('stores nothing when a summary is only generated: the route is the only writer', () => {
    const h = rig();
    sealed();
    expect(h.appended).toEqual([]);
  });
});

describe('what the copy reads', () => {
  it('copies the same whatever the source holds now, because it reads only the token: it needs no reader of elements', async () => {
    const h = rig();
    const request = h.request(sealed());
    expect(request).not.toHaveProperty('readElements');
    expect(await call(request)).toMatchObject({ copied: 1 });
  });

  it('does not import the store of the stored runs, which no route reads', () => {
    const source = readFileSync(fileURLToPath(new URL('./copy-route.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/run-store|RunStore/);
  });
});
