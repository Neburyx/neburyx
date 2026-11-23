import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createMemorySummaryRunStore } from '../../../ee/ask/src/case-summary/run-store.js';
import { loadSummaryInstructions } from '../../../ee/ask/src/case-summary/load-instructions.js';
import { makeAskFolder, removeAskFolders } from '../../../ee/ask/src/testing/ask-folder.js';
import { startModelStub, type ModelStub } from './model-stub.js';
import { defined, expectNoVerdict, offenceWordsIn, sentencesOf } from './checks.js';
import { replyOf, startRig } from './testing/rig.js';
import { node, reading } from './view.js';

const PROMPTS = resolve(import.meta.dirname, '../../../ee/ask/prompts');
const TYPOLOGY_FILE = resolve(import.meta.dirname, '../../../domain-packs/banking-fraud/ask/typologies.md');
const typology = readFileSync(TYPOLOGY_FILE, 'utf8');
const prompt = readFileSync(join(PROMPTS, 'summary-prompt.md'), 'utf8');
const directory = mkdtempSync(join(tmpdir(), 'nbx-typology-'));
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
  removeAskFolders();
});

vi.mock('@neburyx/ee-audit', () => ({ createAuditSink: () => ({ sink: { record: async () => undefined }, close: async () => undefined }) }));
vi.mock('../../../ee/ask/src/questions/pg-run-store.js', () => ({ createPgRunStore: () => ({ record: async () => undefined, close: async () => undefined }) }));

const { createEnterpriseExtension } = await import('../../../ee/ask/src/index.js');

const view = reading([node('account', 'AC-1', 'AC-1'), node('account', 'AC-2', 'AC-2')]);

describe('the scanner for offence words (canaries)', () => {
  it.each(['guilt', 'fraud', 'laundering', 'criminal', 'offence', 'offender', 'perpetrator', 'suspect', 'suspicious', 'intent', 'deliberate', 'illegal', 'unlawful', 'convicted', 'culprit'])('canary: finds %s in a line of the typology', (word) => {
    expect(offenceWordsIn(`${typology}\n- Shape: an arrangement of ${word} acts.`)).not.toEqual([]);
  });
});

describe('the shipped files', () => {
  it('has a typology that names each shape, words none of them as an offence, allows the shape of one, cited, and forbids saying that an arrangement is one', () => {
    for (const shape of ['fan-in', 'fan-out', 'cycle', 'rapid pass-through', 'shared device or address']) expect(typology.toLowerCase(), shape).toContain(shape);
    expect(offenceWordsIn(typology)).toEqual([]);
    expect(typology).toMatch(/having the shape of/iu);
    expect(typology).toMatch(/cit(e|ing)/iu);
    expect(typology).toMatch(/never say that an arrangement is/iu);
  });

  it('has a prompt that expressly prohibits stating or implying guilt, fraud, intent or a conclusion, and instructions that hold both files', async () => {
    expect(prompt).toMatch(/never state or imply guilt, fraud, intent or a conclusion/iu);
    const loaded = await loadSummaryInstructions({ env: { NEBURYX_SUMMARY_TYPOLOGY_FILE: TYPOLOGY_FILE } });
    expect(loaded.ok && loaded.instructions.text.includes(prompt.trim())).toBe(true);
    expect(loaded.ok && loaded.instructions.text.includes(typology.trim())).toBe(true);
  });
});

describe('a shape in the reply', () => {
  const run = async (text: string, calls = 2) => {
    const rig = startRig({ replies: [replyOf({ text, cites: ['n1', 'n2'] })], settings: { maxCalls: calls } });
    const outcome = await rig.summarize(view);
    return { outcome, requests: rig.requests };
  };

  it('is kept when the sentence says the arrangement has the shape of a fan-in', async () => {
    const { outcome, requests } = await run('The accounts AC-1 and AC-2 have the shape of a fan-in.');
    expect(outcome.status).toBe('ok');
    expect(requests).toHaveLength(1);
  });

  it.each(['The arrangement of AC-1 and AC-2 shows laundering.', 'AC-1 and AC-2 are an offence.', 'The holder of AC-1 acted with intent.'])('earns a further call and, when the last call still holds it, is removed: %s', async (text) => {
    const { outcome, requests } = await run(text);
    expect(requests).toHaveLength(2);
    expect(outcome.status).toBe('unsupported');
    expectNoVerdict(sentencesOf(outcome));
  });
});

describe('a replacement typology file, through the real extension, its own summarizer and a scripted provider on the loopback address', () => {
  const SINK_CONTEXT = { databaseUrl: 'postgres://app@db.example.test:5432/neburyx', poolSize: 1, connectionTimeoutMs: 100, statementTimeoutMs: 100, queryTimeoutMs: 100, newId: () => 'id', onConnectionError: () => undefined };
  const keyFile = join(directory, 'token-key');
  writeFileSync(keyFile, `${'ab'.repeat(32)}\n`, { mode: 0o600 });
  const envOf = (folder: string, extra: Record<string, string> = {}) => ({ NEBURYX_ASK_API_KEY: 'not-a-real-key', NEBURYX_ASK_MAPPING_FOLDER: folder, NEBURYX_SUMMARY_MAX_INPUT_TOKENS: '100000', NEBURYX_SUMMARY_TOKEN_KEY_FILE: keyFile, ...extra });
  const GOOD = { text: 'AC-1 is listed.', cites: ['n1'] };

  async function summarizeThrough(env: Record<string, string>, stub: ModelStub) {
    const extension = createEnterpriseExtension({ modelBaseUrl: stub.baseUrl, summaryRunStore: () => createMemorySummaryRunStore() });
    expect(await extension.configure?.({ preview: true }, env, { sourceIds: ['demo'] })).toEqual({ ok: true });
    extension.createAuditSink?.(SINK_CONTEXT);
    const summarizer = defined(extension.caseSummarizer?.(), 'the summarizer of the extension');
    stub.requests.length = 0;
    const reply = replyOf(GOOD, { text: 'Listed.', cites: [] }, { text: 'This is evidence of fraud.', cites: ['n1'] }, { text: 'There are 987654 records.', cites: ['n1'] }, { text: 'Mira Holt is connected.', cites: ['n1'] });
    stub.replies.push(...Array.from({ length: 5 }, () => reply));
    const outcome = await summarizer.summarize(
      { actorId: 'analyst-1', actorRole: 'investigator', traceId: 'trace-1', policyVersion: 'p1', request: { investigationId: '0192f000-0000-7000-8000-000000000042', sourceId: 'demo', entities: [], edges: [], aggregates: [], derived: [] }, reading: view },
      new AbortController().signal,
    );
    const instructions = defined(extension.summaryInstructions(), 'the instructions of the extension');
    return { outcome, instructions, body: z.object({ system: z.array(z.object({ text: z.string() })), messages: z.array(z.object({ content: z.string() })) }).parse(JSON.parse(defined(stub.requests[0], 'the request'))) };
  }

  it('carries the file into the instructions and their hash that the summarizer of the extension sends, and changes neither the reply format nor the checks', async () => {
    const replacement = join(directory, 'replacement.md');
    writeFileSync(replacement, '# Our shapes\n\nA ring is several accounts that pass funds in a loop.\n');
    const folder = makeAskFolder(['demo']);
    const stub = await startModelStub();
    try {
      const shipped = await summarizeThrough(envOf(folder), stub);
      const replaced = await summarizeThrough(envOf(folder, { NEBURYX_SUMMARY_TYPOLOGY_FILE: replacement }), stub);
      for (const run of [shipped, replaced]) {
        expect(defined(run.body.system[0], 'the system block').text).toBe(run.instructions.text);
        expect(run.body.messages[0]?.content).toContain('AC-1');
        expect(sentencesOf(run.outcome)).toEqual([GOOD]);
      }
      expect(replaced.instructions.sha256).not.toBe(shipped.instructions.sha256);
      expect(replaced.instructions.text).toContain('A ring is several accounts');
      expect(replaced.instructions.text).not.toContain('Fan-in');
      const format = (text: string): string => text.slice(text.indexOf('# Reply format'));
      expect(format(replaced.instructions.text)).toBe(format(shipped.instructions.text));
    } finally {
      await stub.close();
    }
  });
});
