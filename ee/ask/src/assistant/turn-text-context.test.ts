import { ExtensionRefusal, assistantTurnAuditDetailSchema, auditDetailSchema, type AssistantThreadTurnWrite, type AuditEvent, type RecordQueue } from '@neburyx/contracts';
import { AuditUnavailableError } from '@neburyx/ee-ai-runtime';
import { afterAll, describe, expect, it } from 'vitest';
import { removeAskFolders } from '../testing/ask-folder.js';
import { BODY, V, answerOf, heavyResult, nodeOf, ok, okResult, rig, routeAsk, type Rig, type RigOptions } from '../testing/assistant-rig.js';
import { createMemoryAssistantPendingStore } from './pending-store.js';
import { THREAD_TEXT_INTRO } from './thread-text-context.js';
import { createMemoryAssistantThreadStore, type AssistantThreadStore } from './thread-store.js';

afterAll(removeAskFolders);

const PERSON = '0192f000-0000-7000-8000-000000000001';
const INVESTIGATION = '0192f000-0000-7000-8000-0000000000a1';
const VERSION = 'sv1:a';
const A1 = { sourceId: 'demo', entityType: V.anchor, stableId: 'A-1' };
const UNPLACED = ok('{"route":"refuse","cause":"unplaced"}');
const drain = async (): Promise<void> => {
  for (let step = 0; step < 20; step += 1) await Promise.resolve();
};
const failures: Record<string, string>[] = [];
const immediate: RecordQueue = { enqueue: (job) => void job.write().catch(() => failures.push({ ...job.ids })) };

const stored = (over: Partial<AssistantThreadTurnWrite> = {}): AssistantThreadTurnWrite => ({
  id: crypto.randomUUID(),
  investigationId: INVESTIGATION,
  userId: PERSON,
  at: new Date('2026-11-18T10:00:00Z'),
  route: 'view',
  outcome: 'answered',
  questionHash: 'a'.repeat(64),
  entities: [],
  citationRefs: [],
  steps: 0,
  question: 'Who holds the item?',
  maskOn: false,
  sensitivityVersion: VERSION,
  answer: { blocks: [{ kind: 'sentences', items: [{ form: 'frozen', text: 'Two items are listed.', cites: [] }, { form: 'bound', segments: [{ element: A1, property: '(title)' }, { literal: ' holds it.' }], cites: [A1] }, { form: 'unbound', text: 'PLANTED-UNBOUND is listed.', cites: [] }] }] },
  ...over,
});

interface Turn {
  readonly given: { context?: string | undefined }[];
  readonly rig: Rig;
  readonly threads: ReturnType<typeof createMemoryAssistantThreadStore>;
  readonly reads: { count: number };
  readonly answer: unknown;
}

/** One turn through the real route whose loop is a stand-in that notes what it is given; the thread holds the turns the test seeds. */
async function run(over: { readonly env?: Record<string, string>; readonly mask?: boolean; readonly version?: string | null; readonly versionOf?: () => string; readonly signal?: AbortSignal; readonly rigOut?: { r?: Rig }; readonly seed?: readonly AssistantThreadTurnWrite[]; readonly store?: (inner: AssistantThreadStore) => AssistantThreadStore } & Partial<RigOptions> = {}): Promise<Turn> {
  failures.length = 0;
  const threads = createMemoryAssistantThreadStore();
  for (const turn of over.seed ?? [stored()]) await threads.append(turn, 0);
  const reads = { count: 0 };
  const counted: AssistantThreadStore = { ...threads, read: (...args) => (reads.count++, threads.read(...args)) };
  const given: Turn['given'] = [];
  const { env, mask, version, versionOf, signal, rigOut, seed, store, ...options } = over;
  void seed;
  const made = await rig({ reply: UNPLACED, threadStore: store === undefined ? counted : store(counted), records: immediate, settingsEnv: env ?? {}, loopStub: async (input) => (given.push({ context: input.context }), undefined), readNodes: () => [nodeOf('A-1', 'Live title')], ...options });
  if (rigOut !== undefined) rigOut.r = made;
  const answer = await made.route.handler(made.request({ ...BODY, investigationId: INVESTIGATION, ...(mask === true ? { mask: true } : {}) }, { principalId: PERSON, ...(signal === undefined ? {} : { signal }), sensitivityVersion: () => { if (version === null) throw new Error('no version'); return versionOf?.() ?? version ?? VERSION; } }));
  await drain();
  return { given, rig: made, threads, reads, answer };
}

const closed = (events: readonly AuditEvent[]) => {
  const detail = auditDetailSchema.parse(events.find((event) => event.action === 'assistant.turn.closed')?.detail);
  return assistantTurnAuditDetailSchema.parse('turn' in detail ? detail.turn : undefined);
};

const OFF = { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'false' };

describe('the stored text of the thread given to the loop, by the real route', () => {
  it('is not read when the setting is false: the loop is given the references\' context exactly as before and the store\'s text read is never made', async () => {
    const off = await run({ env: OFF });
    expect(off.reads.count).toBe(0);
    expect(off.given).toHaveLength(1);
    expect(off.given[0]?.context).toMatch(/^Earlier turns of this thread, oldest first:\n1\. view/u);
    expect(off.given[0]?.context).not.toContain(THREAD_TEXT_INTRO);
    expect(off.given[0]?.context).not.toContain('Two items');
    expect(closed(off.rig.events)).toMatchObject({ propertyValuesSent: false });
  });

  it('is given when the setting is absent, as when it is true: the default is on', async () => {
    const [absent, on] = [await run(), await run({ env: { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true' } })];
    expect(absent.given[0]?.context).toContain(THREAD_TEXT_INTRO);
    expect(absent.given[0]?.context).toBe(on.given[0]?.context);
  });

  it('gives the text after the references\' context, which is byte for byte what it is with the setting off, with the question and the answer as the thread read presents them', async () => {
    const off = await run({ env: OFF });
    const on = await run({ env: { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true' } });
    const context = on.given[0]?.context ?? '';
    expect(on.reads.count).toBe(1);
    expect(context.startsWith(`${off.given[0]?.context}\n\n${THREAD_TEXT_INTRO}\n`)).toBe(true);
    expect(context).toContain('1. Question: "Who holds the item?"');
    expect(context).toContain('"Two items are listed."');
    expect(context).toContain('"Live title holds it."');
    expect(context).toContain('PLANTED-UNBOUND');
    expect(closed(on.rig.events)).toMatchObject({ propertyValuesSent: true });
    expect(JSON.stringify(on.rig.events)).not.toContain('Two items are listed');
  });

  it('is what the panel would draw under the mask: the gate\'s masked title, no unbound text and none at all for a version that is not the current one, and the gate is asked under the mask', async () => {
    const masked = await run({ env: { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true' }, mask: true, readNodes: (_refs, mask) => [nodeOf('A-1', mask ? '*****' : 'Live title')] });
    const context = masked.given[0]?.context ?? '';
    expect(context).toContain('"***** holds it."');
    expect(context).toContain('"Two items are listed."');
    expect(context).not.toContain('PLANTED-UNBOUND');
    expect(masked.rig.elementReads.every((read) => read.mask)).toBe(true);
    const changed = await run({ env: { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true' }, mask: true, version: 'sv1:changed' });
    expect(changed.given[0]?.context).toContain('Question: "Who holds the item?"');
    expect(changed.given[0]?.context).toContain('Answer: (no text of it is shown)');
    expect(changed.given[0]?.context).not.toContain('Two items');
  });

  it('leaves the router\'s request and the references\' context as they are with the text on', async () => {
    const off = await run({ env: OFF });
    const on = await run({ env: { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true' } });
    const routed = (t: Turn) => t.rig.fixture.calls.filter((request) => request.promptId === 'assistant.route').map((request) => request.values);
    expect(routed(on)).toEqual(routed(off));
    expect(JSON.stringify(routed(on))).not.toContain('Two items');
  });

  it('keeps to the budget of half the input limit: the oldest turns are dropped first and none is given when the newest does not fit', async () => {
    const turn = (word: string) => stored({ question: `question ${word}`, answer: { blocks: [{ kind: 'sentences', items: [{ form: 'frozen', text: `${word} ${'x'.repeat(1900)}`, cites: [] }] }] } });
    const seed = [turn('one'), turn('two'), turn('three')];
    const tight = await run({ seed, env: { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true', NEBURYX_ASSISTANT_MAX_INPUT_TOKENS: '2500' } });
    const context = tight.given[0]?.context ?? '';
    expect(context).toContain('question three');
    expect(context).not.toContain('question one');
    const none = await run({ seed, env: { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true', NEBURYX_ASSISTANT_MAX_INPUT_TOKENS: '800' } });
    expect(none.given[0]?.context).not.toContain(THREAD_TEXT_INTRO);
    expect(none.given[0]?.context).toMatch(/^Earlier turns of this thread/u);
  });

  it('goes on without the text when the store cannot be read for it, and counts a failed record of the thread', async () => {
    const t = await run({ env: { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true' }, store: (inner) => ({ ...inner, read: () => Promise.reject(new Error('down')) }) });
    expect(t.given).toHaveLength(1);
    expect(t.given[0]?.context).not.toContain(THREAD_TEXT_INTRO);
    expect(failures).toEqual([{ turnId: expect.any(String), step: 'context-text' }]);
  });

  it('ends the turn as it ends when the references\' context cannot be read when the gate fails reading the elements the text names', async () => {
    // an error that is not the gate's own refusal is the caller's to answer, as the references' context's is
    await expect(run({ env: { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true' }, viewReadThrows: new Error('down') })).rejects.toThrow('down');
  });

  it('is given for a thread with no turn as nothing', async () => {
    const t = await run({ env: { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true' }, seed: [] });
    expect(t.given[0]?.context).toBeUndefined();
  });

  it('is given nothing under the mask when the sensitivity version cannot be looked up, though the turn goes on', async () => {
    const t = await run({ env: { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true' }, mask: true, version: null });
    expect(t.given).toHaveLength(1);
    expect(t.given[0]?.context).toContain('Answer: (no text of it is shown)');
    expect(t.given[0]?.context).not.toContain('Two items');
  });

  it('answers an audit failure of the gate\'s read as the audit being unavailable, which is not swallowed as a failure of the store, and makes no model call after it', async () => {
    await expect(run({ env: { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true' }, viewReadThrows: new AuditUnavailableError() })).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(failures).toEqual([]);
  });

  it('keeps the text out of every audit event and log, and records the setting in the run record, in both states', async () => {
    const logs: { fields: Record<string, unknown>; message: string }[] = [];
    for (const on of [true, false]) {
      const runs = (await import('./run-store.js')).createMemoryAssistantRunStore();
      const t = await run({ env: on ? { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true' } : OFF, logs, runStore: runs });
      expect(JSON.stringify(t.rig.events)).not.toContain('Two items are listed');
      expect(JSON.stringify(t.rig.events)).not.toContain('Live title');
      expect(runs.runs[0]?.start.settings).toMatchObject({ contextText: on });
    }
    expect(JSON.stringify(logs)).not.toContain('Two items are listed');
  });

  it('presents the text under the version it has when the store has been read, not the one it had before: a mapping that changes during the read gives no text of the turn', async () => {
    const current = { version: VERSION };
    const t = await run({ env: { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true' }, mask: true, versionOf: () => current.version, store: (inner) => ({ ...inner, read: async (...args) => { const read = await inner.read(...args); current.version = 'sv1:changed'; return read; } }) });
    expect(t.given[0]?.context).toContain('Answer: (no text of it is shown)');
    expect(t.given[0]?.context).not.toContain('Two items');
  });

  it('gives no text at all when the mapping changes while the bound elements are read', async () => {
    const current = { version: VERSION };
    const t = await run({ env: { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true' }, mask: true, versionOf: () => current.version, readNodes: () => { current.version = 'sv1:changed'; return [nodeOf('A-1', '*****')]; } });
    expect(t.given).toHaveLength(1);
    expect(t.given[0]?.context).not.toContain(THREAD_TEXT_INTRO);
    expect(t.given[0]?.context).not.toContain('*****');
  });

  it('leaves the loop\'s context, the identifiers and the gate reads as they were with the setting off, and the text read adds one read of the bound elements', async () => {
    const seed = [stored({ route: 'ask', intent: 'shared', entities: [{ role: 'id', ref: A1 }], citationRefs: [A1] })];
    const off = await run({ seed, env: OFF });
    const on = await run({ seed, env: { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true' } });
    const golden = `Earlier turns of this thread, oldest first:\n1. ask "shared"; ran for id = c1; cited c1\n\nElements of those turns, by key | title | type:\nc1 | "Live title" | "${V.anchor}"\nIdentifiers of those elements, to give a tool as values:\nc1 = ${V.anchor} A-1`;
    expect(off.given[0]?.context).toBe(golden);
    expect(on.given[0]?.context?.startsWith(`${golden}\n\n${THREAD_TEXT_INTRO}\n`)).toBe(true);
    expect(on.rig.elementReads.length).toBe(off.rig.elementReads.length + 1);
  });

  it('gives no text when the older turn has it and the turns of the window, which is all the store limits, have none', async () => {
    const seed = [stored({ question: 'older question' }), stored({ question: undefined, answer: undefined, maskOn: undefined, sensitivityVersion: undefined }), stored({ question: undefined, answer: undefined, maskOn: undefined, sensitivityVersion: undefined })];
    const t = await run({ seed, env: { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true', NEBURYX_ASSISTANT_CONTEXT_TURNS: '2' } });
    expect(t.given[0]?.context).not.toContain('older question');
    expect(t.given[0]?.context).not.toContain(THREAD_TEXT_INTRO);
  });

  it('ends a turn whose request was cancelled before the read as cancelled, reads no text and makes no loop call', async () => {
    const given: unknown[] = [];
    const reads = { count: 0 };
    const threads = createMemoryAssistantThreadStore();
    await threads.append(stored(), 0);
    const made = await rig({ reply: UNPLACED, threadStore: { ...threads, read: (...args) => (reads.count++, threads.read(...args)) }, records: immediate, settingsEnv: { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true' }, loopStub: async (input) => (given.push(input), undefined) });
    await expect(made.route.handler(made.request({ ...BODY, investigationId: INVESTIGATION }, { principalId: PERSON, signal: AbortSignal.abort() }))).rejects.toThrow('the request was cancelled');
    expect(reads.count).toBe(0);
    expect(given).toEqual([]);
  });

  it('ends a turn cancelled during a read that succeeds as cancelled, with no loop call', async () => {
    const controller = new AbortController();
    const given: unknown[] = [];
    await expect(run({ env: { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true' }, signal: controller.signal, onViewRead: () => controller.abort(), loopStub: async (input) => (given.push(input), undefined) })).rejects.toThrow('the request was cancelled');
    expect(given).toEqual([]);
  });

  it('ends a turn whose time ran out while the elements were read as a timeout, with no loop call, whether the read failed or succeeded', async () => {
    for (const fails of [true, false]) {
      const given: unknown[] = [];
      const holder: { r?: Rig } = {};
      const t = await run({ env: { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true' }, onViewRead: () => holder.r?.expire(), ...(fails ? { viewReadThrows: new Error('aborted') } : {}), loopStub: async (input) => (given.push(input), undefined), rigOut: holder });
      expect(t.answer).toMatchObject({ status: 'unavailable', kind: 'timeout' });
      expect(given).toEqual([]);
    }
  });

  it.each([
    ['the source is unavailable', new ExtensionRefusal({ code: 'SOURCE_UNAVAILABLE', reason: 'unreachable' }), { status: 'unavailable', kind: 'source-unavailable' }],
    ['the source is busy', new ExtensionRefusal({ code: 'SOURCE_BUSY' }), { status: 'unavailable', kind: 'busy' }],
  ] as const)('answers a gate that refuses because %s as the references\' context is answered, with no loop call and none of the text in any audit event or log', async (_name, error, expected) => {
    const logs: { fields: Record<string, unknown>; message: string }[] = [];
    const t = await run({ env: { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true' }, viewReadThrows: error, logs });
    expect(t.answer).toMatchObject(expected);
    expect(t.given).toHaveLength(0);
    expect(JSON.stringify([t.rig.events, logs])).not.toContain('Two items are listed');
  });

  it('lets an access refusal of the gate through as the refusal it is, with no loop call', async () => {
    await expect(run({ env: { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true' }, viewReadThrows: new ExtensionRefusal({ code: 'ACCESS_DENIED' }) })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });
});

/** The turn through the real loop, over a scripted model, and a heavy first step that waits for the analyst. */
const GOOD = ok(JSON.stringify({ sentences: [{ text: 'Account A-1 and account A-2 are listed.', cites: ['r1', 'r2'] }] }));
const byId = (id: string) => ok(JSON.stringify({ tool: 'byId', values: { id } }));
const DONE = ok('{"done":true}');
const sequence = (...replies: ReturnType<typeof ok>[]) => {
  let next = 0;
  return () => replies[Math.min(next++, replies.length - 1)] ?? DONE;
};
/** The input limit under which the loop's own input is over the limit only with the text of the seeded turn. */
const LIMIT = 6102;
const heavyFor = (heavy: string) => (continuing: boolean, asked: unknown) => (JSON.stringify(asked).includes(heavy) && !continuing ? { status: 'ok' as const, result: heavyResult() } : { status: 'ok' as const, result: okResult() });

describe('the stored text and the loop that is really run', () => {
  it.each(['confirm', 'skip'] as const)('does not read the text again for the turn that goes on after the analyst\'s %s, which is given none', async (decision) => {
    const threads = createMemoryAssistantThreadStore();
    await threads.append(stored(), 0);
    const reads = { count: 0 };
    const counted: AssistantThreadStore = { ...threads, read: (...args) => (reads.count++, threads.read(...args)) };
    const pending = createMemoryAssistantPendingStore();
    const runs = (await import('./run-store.js')).createMemoryAssistantRunStore();
    const r = await rig({ reply: routeAsk('shared', { id: 'A-1' }), step: sequence(byId('A-2'), byId('A-9'), DONE), answer: GOOD, pending, run: heavyFor('A-9'), runStore: runs, threadStore: counted, records: immediate, settingsEnv: { NEBURYX_ASSISTANT_CONTEXT_TEXT: 'true' }, readNodes: () => [nodeOf('A-1', 'Live title')] });
    const request = (body: unknown) => r.request(body, { principalId: PERSON, sensitivityVersion: () => VERSION });
    const first = await answerOf(r.route.handler(request({ ...BODY, investigationId: INVESTIGATION })));
    if (first.status !== 'confirmation') throw new Error(`not waiting: ${JSON.stringify(first).slice(0, 160)}`);
    expect(reads.count).toBe(1);
    const callTexts = (): string[] => runs.runs.flatMap((run) => run.callStarts.map((call) => `${call.instructionsText}\n${call.valuesText}`));
    // the turn that began holds the seeded text in the input of its model calls
    const before = callTexts();
    expect(before.some((text) => text.includes(THREAD_TEXT_INTRO))).toBe(true);
    const again = await answerOf(r.route.handler(request({ ...BODY, investigationId: INVESTIGATION, confirmation: { pendingId: first.pendingId, plan: first.plan, decision } })));
    expect(again.status).not.toBe('confirmation-invalid');
    // the decision itself reads no text, and no model call made after it holds any of it
    expect(reads.count).toBe(1);
    const after = callTexts().slice(before.length);
    expect(after.length).toBeGreaterThan(0);
    for (const text of after) {
      expect(text).not.toContain(THREAD_TEXT_INTRO);
      expect(text).not.toContain('Two items are listed');
    }
  });

  it('drops a sentence that states a figure only the text holds, as it does without the text: the text adds no source to cite and changes no check', async () => {
    const answerWith = ok(JSON.stringify({ sentences: [{ text: 'Account A-1 holds 7777 items.', cites: ['r1'] }, { text: 'Account A-1 is listed.', cites: ['r1'] }] }));
    const seed = [stored({ answer: { blocks: [{ kind: 'sentences', items: [{ form: 'frozen', text: 'Account A-1 holds 7777 items.', cites: [] }] }] } })];
    const outcomes: unknown[] = [];
    for (const on of [false, true]) {
      const runs = (await import('./run-store.js')).createMemoryAssistantRunStore();
      const threads = createMemoryAssistantThreadStore();
      for (const turn of seed) await threads.append(turn, 0);
      const r = await rig({ reply: routeAsk('shared', { id: 'A-1' }), step: sequence(DONE), answer: answerWith, run: heavyFor('none'), threadStore: threads, runStore: runs, records: immediate, settingsEnv: { NEBURYX_ASSISTANT_CONTEXT_TEXT: on ? 'true' : 'false' }, readNodes: () => [nodeOf('A-1', 'Live title')] });
      const answer = await answerOf(r.route.handler(r.request({ ...BODY, investigationId: INVESTIGATION }, { principalId: PERSON, sensitivityVersion: () => VERSION })));
      outcomes.push(answer);
      expect(JSON.stringify(answer)).not.toContain('7777');
      // the context is kept only where every call's text is kept: the stored run's call
      const callText = runs.runs.flatMap((run) => run.callStarts.map((call) => `${call.instructionsText}\n${call.valuesText}`)).join('\n');
      expect(callText.includes('Earlier questions and answers of this thread')).toBe(on);
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
  });

  it('still ends a turn whose complete input is over the input limit through the input-limit path, though the text fits its share, and makes no model call after it', async () => {
    const big = stored({ answer: { blocks: [{ kind: 'sentences', items: [{ form: 'frozen', text: 'z'.repeat(1900), cites: [] }] }] } });
    const statuses: unknown[] = [];
    const calls: number[] = [];
    for (const on of [false, true]) {
      const threads = createMemoryAssistantThreadStore();
      await threads.append(big, 0);
      const r = await rig({ reply: routeAsk('shared', { id: 'A-1' }), step: sequence(DONE), answer: GOOD, run: heavyFor('none'), threadStore: threads, records: immediate, maxInputTokens: LIMIT, settingsEnv: { NEBURYX_ASSISTANT_CONTEXT_TEXT: on ? 'true' : 'false' }, readNodes: () => [nodeOf('A-1', 'Live title')] });
      const answer = await answerOf(r.route.handler(r.request({ ...BODY, investigationId: INVESTIGATION }, { principalId: PERSON, sensitivityVersion: () => VERSION })));
      statuses.push(answer);
      calls.push(r.events.filter((event) => event.action === 'assistant.agent').length);
    }
    // without the text the scripted loop ends on its calls; with it the existing input guard ends it, after the one call that fitted and with none after
    expect(statuses[0]).toMatchObject({ status: 'limit', limit: 'calls' });
    expect(statuses[1]).toMatchObject({ status: 'limit', limit: 'input' });
    expect(calls).toEqual([3, 1]);
  });
});
