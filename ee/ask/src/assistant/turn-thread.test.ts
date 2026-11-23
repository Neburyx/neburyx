import { createHash } from 'node:crypto';
import { ExtensionRefusal, askRunResultSchema, assistantTurnAnswerSchema, auditDetailSchema, tablesOfBlocks, type AssistantThreadTurnWrite, type ExtensionRequest, type RecordJob, type RecordQueue } from '@neburyx/contracts';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { removeAskFolders } from '../testing/ask-folder.js';
import { BODY, VIEW_BODY, answerOf, fileQueryResult, heavyResult, ok, okResult, rig, routeAsk, sign, type Rig, type RigOptions } from '../testing/assistant-rig.js';
import { ROUTER_PROMPT_VERSION } from './router.js';
import { createMemoryAssistantRunStore } from './run-store.js';
import { createMemoryAssistantThreadStore, type AssistantThreadStore, type MemoryAssistantThreadStore } from './thread-store.js';
import { TURN_CLOSED_ACTION, noteTurn, noteTurnStarted, withTurnAudit } from './turn-audit.js';

afterAll(removeAskFolders);

const SHARED = routeAsk('shared', { id: 'A-1' });
const PERSON = '0192f000-0000-7000-8000-000000000001';
const OTHER = '0192f000-0000-7000-8000-000000000002';
const INVESTIGATION = '0192f000-0000-7000-8000-0000000000a1';
const SECOND = '0192f000-0000-7000-8000-0000000000a2';
const BASE = { ...BODY, investigationId: INVESTIGATION };
const PLACEHOLDER = { status: 'not-answered', route: 'view', sentence: 'placeholder' } as const;
const SHA = /^[0-9a-f]{64}$/;
const BETWEEN = { between: { parameters: ['a', 'b'], template: 'shortest-paths', settings: { ends: [{ entityType: 'widget', stableId: '$a' }, { entityType: 'widget', stableId: '$b' }], relTypes: ['LINKS'], maxHops: 3, limit: 5 } } };
const refOf = (stableId: string) => ({ sourceId: 'demo', entityType: 'widget', stableId });
const nodeOf = (stableId: string) => ({ ref: refOf(stableId), display: { title: `Account ${stableId}`, type: 'widget' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
const edgeOf = (from: string, to: string) => ({ ref: { sourceId: 'demo', type: 'LINKS', from: 'widget', to: 'widget', stableId: `${from}-${to}` }, from: refOf(from), to: refOf(to), type: 'LINKS', direction: 'from-to', semantics: 'stored', properties: [], evidenceRefs: [], qualityFlags: [] });
const pathsResult = () =>
  askRunResultSchema.parse({
    templateId: 'shortest-paths',
    result: { status: 'ok', paths: [{ hops: 1, steps: [{ from: refOf('a'), to: refOf('z'), relationshipType: 'LINKS', evidenceRefs: [] }] }], nodes: [nodeOf('a'), nodeOf('z')], edges: [edgeOf('a', 'z')], capReached: false, partial: false, elapsedMs: 1, warnings: [] },
  });

const drain = async (): Promise<void> => {
  for (let step = 0; step < 20; step += 1) await Promise.resolve();
};

/** A queue of records that runs each job at once, and notes the failed and the dropped ones by their ids. */
function queue(size = 1000) {
  const failed: Record<string, string>[] = [];
  const dropped: Record<string, string>[] = [];
  const jobs: RecordJob[] = [];
  const records: RecordQueue = {
    enqueue(job) {
      if (jobs.length >= size) {
        dropped.push({ ...job.ids });
        return;
      }
      jobs.push(job);
      void job.write().catch(() => failed.push({ ...job.ids }));
    },
  };
  return { records, failed, dropped, jobs };
}

interface Turn {
  readonly r: Rig;
  readonly threads: MemoryAssistantThreadStore;
  readonly queue: ReturnType<typeof queue>;
}

async function turnRig(options: RigOptions = {}, threads: MemoryAssistantThreadStore = createMemoryAssistantThreadStore(), records = queue()): Promise<Turn> {
  const r = await rig({ ...options, threadStore: threads, records: records.records });
  return { r, threads, queue: records };
}

const run = async (turn: Turn, body: unknown = BASE, over: Partial<ExtensionRequest> = {}) => {
  const result = await turn.r.route.handler(turn.r.request(body, { principalId: PERSON, ...over })).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await drain();
  return result;
};

const stored = (turn: Turn, person = PERSON, investigation = INVESTIGATION): AssistantThreadTurnWrite[] => turn.threads.threads.get(`${investigation}:${person}`)?.turns ?? [];

describe('a turn kept in the thread as references and metadata', () => {
  it('keeps an answered intent with its route, template, keyed hash, the element each parameter resolved to, what it cited, the steps, the model and the run', async () => {
    const runs = createMemoryAssistantRunStore();
    const turn = await turnRig({ reply: { ...SHARED, usage: { kind: 'known', inputTokens: 20, outputTokens: 10 } }, runStore: runs });
    await run(turn);
    const [kept] = stored(turn);
    expect(stored(turn)).toHaveLength(1);
    expect(kept).toMatchObject({ route: 'ask', outcome: 'answered', intent: 'shared', templateId: 'shared-attribute', steps: 1, modelRef: 'fixture-model', promptVersion: String(ROUTER_PROMPT_VERSION), tokensIn: 20, tokensOut: 10, runId: runs.runs[0]?.id, investigationId: INVESTIGATION, userId: PERSON });
    expect(kept?.questionHash).toMatch(SHA);
    expect(kept?.entities).toEqual([{ role: 'id', ref: { sourceId: 'demo', entityType: 'widget', stableId: 'A-1' } }]);
    expect(kept?.citationRefs).toEqual([
      { sourceId: 'demo', entityType: 'widget', stableId: 'A-1' },
      { sourceId: 'demo', entityType: 'widget', stableId: 'A-2' },
    ]);
    expect(kept?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps the element of each place a parameter has: both ends of a path, and two parameters of equal value each with their own role', async () => {
    const ends = await turnRig({ reply: routeAsk('between', { a: 'a', b: 'z' }), intents: BETWEEN, run: () => ({ status: 'ok', result: pathsResult() }) });
    await run(ends);
    expect(stored(ends)[0]?.entities).toEqual([
      { role: 'a', ref: refOf('a') },
      { role: 'b', ref: refOf('z') },
    ]);
    const equal = await turnRig({ reply: routeAsk('between', { a: 'a', b: 'a' }), intents: BETWEEN, run: () => ({ status: 'ok', result: pathsResult() }) });
    await run(equal);
    expect(stored(equal)[0]?.entities).toEqual([
      { role: 'a', ref: refOf('a') },
      { role: 'b', ref: refOf('a') },
    ]);
  });

  it('keeps the continue of a heavy stop with no model fields, and a file query with no template and no resolved element', async () => {
    const continued = await turnRig({ reply: SHARED, run: (continuing) => ({ status: 'ok', result: continuing ? okResult() : heavyResult() }) });
    const first = await answerOf(continued.r.route.handler(continued.r.request(BASE, { principalId: PERSON })));
    await drain();
    const token = first.status === 'answered' && first.route === 'ask' && 'answer' in first && 'answered' in first.answer ? first.answer.answered.continueToken : undefined;
    expect(stored(continued)).toHaveLength(1);
    await run(continued, { sourceId: 'demo', investigationId: INVESTIGATION, viewElementKeys: [], continue: { intent: 'shared', entities: { id: 'A-1' }, continueToken: token } });
    const after = stored(continued)[1];
    expect(after).toMatchObject({ route: 'ask', outcome: 'answered', intent: 'shared', steps: 1 });
    // a continue carries no typed message: its row keeps no question, and the first turn kept the one typed
    expect(after).not.toHaveProperty('question');
    expect(stored(continued)[0]?.question).toBe(BASE.message);
    for (const key of ['modelRef', 'promptVersion', 'tokensIn', 'tokensOut']) expect(after).not.toHaveProperty(key);
    const query = await turnRig({ reply: routeAsk('byId', { id: 'A-1' }), run: () => ({ status: 'ok', result: fileQueryResult() }) });
    await run(query);
    expect(stored(query)[0]).toMatchObject({ intent: 'byId', entities: [] });
    expect(stored(query)[0]).not.toHaveProperty('templateId');
  });

  it('leaves out tokens the provider did not state, rather than storing 0', async () => {
    const turn = await turnRig({ reply: { kind: 'ok', text: '{"route":"refuse","cause":"verdict"}' } });
    await run(turn);
    const [kept] = stored(turn);
    expect(kept).toMatchObject({ modelRef: 'fixture-model', route: 'refuse' });
    expect(kept).not.toHaveProperty('tokensIn');
    expect(kept).not.toHaveProperty('tokensOut');
  });

  it.each(['verdict', 'raw-query', 'other-source', 'unplaced'] as const)('keeps a refusal of the router with the cause %s and nothing cited', async (cause) => {
    const turn = await turnRig({ reply: ok(JSON.stringify({ route: 'refuse', cause })) });
    await run(turn);
    expect(stored(turn)).toEqual([expect.objectContaining({ route: 'refuse', outcome: 'refused', cause, entities: [], citationRefs: [], steps: 0 })]);
  });

  it.each([
    ['an unknown intent', { reply: routeAsk('nothing-like-it', { id: 'A-1' }) }, 'unknown-intent'],
    ['missing inputs', { reply: routeAsk('shared', {}) }, 'missing-inputs'],
    ['a result that lists nothing', { reply: routeAsk('byId', { id: 'A-9' }), run: () => ({ status: 'ok', result: askRunResultSchema.parse({ templateId: 'file-query', result: { status: 'ok', intent: 'byId', count: { quality: 'exact', value: 0, scope: 'rows' }, nodes: [], edges: [], notices: [], warnings: [] } }) }) as const }, 'nothing-found'],
  ])('keeps %s as a refusal of Ask with its cause', async (_name, options, cause) => {
    const turn = await turnRig(options);
    await run(turn);
    expect(stored(turn)).toEqual([expect.objectContaining({ route: 'ask', outcome: 'refused', cause })]);
  });

  it('keeps the view turn that was not answered, and an answered view turn with the references it cited, however many and of either kind', async () => {
    const view = await turnRig({ reply: ok('{"route":"view"}') });
    await run(view);
    expect(stored(view)).toEqual([expect.objectContaining({ route: 'view', outcome: 'refused', cause: 'not-answered', citationRefs: [] })]);
    const threads = createMemoryAssistantThreadStore();
    const records = queue();
    const refs: AssistantThreadTurnWrite['citationRefs'] = [
      ...Array.from({ length: 45 }, (_unused, index) => ({ sourceId: 'demo', entityType: 'widget', stableId: `W-${'9'.repeat(60)}${index}` })),
      { sourceId: 'demo', type: 'LINKS', from: 'widget', to: 'widget', stableId: 'L-1' },
    ];
    const r = await rig({ threadStore: threads, records: records.records });
    const wrapped = withTurnAudit(
      { logger: () => undefined, threads: () => threads, records: () => records.records },
      async () => {
        await noteTurnStarted({ sourceId: 'demo', investigationId: INVESTIGATION, questionHash: 'b'.repeat(64) });
        noteTurn({ route: 'view', answered: true, citedRefs: refs });
        return PLACEHOLDER;
      },
    );
    await wrapped(r.request(BASE, { principalId: PERSON }));
    await drain();
    expect(records.failed).toEqual([]);
    const [kept] = threads.threads.get(`${INVESTIGATION}:${PERSON}`)?.turns ?? [];
    expect(kept).toMatchObject({ route: 'view', outcome: 'answered' });
    expect(kept?.citationRefs).toHaveLength(46);
  });

  it('keeps an answered view turn with the references its answer cited, as many as the audit event counts', async () => {
    const view = await turnRig({ view: ok(JSON.stringify({ sentences: [{ text: 'Account A-1 and account A-2 are in view.', cites: ['n1', 'n2'] }] })) });
    const result = await run(view, { ...VIEW_BODY, investigationId: INVESTIGATION });
    const answer = 'value' in result ? assistantTurnAnswerSchema.parse(result.value) : undefined;
    if (answer?.status !== 'answered' || answer.route !== 'view') throw new Error('not a view answer');
    const [kept] = stored(view);
    expect(kept).toMatchObject({ route: 'view', outcome: 'answered' });
    expect(kept?.citationRefs).toHaveLength(2);
    expect(kept?.citationRefs).toEqual(answer.citations.flatMap((citation) => (citation.kind === 'description' || citation.kind === 'read' ? [] : [citation.ref])));
  });

  it('keeps an answered table turn with the references its rows cited and the count the audit event holds, and its cells in the stored form', async () => {
    const view = await turnRig({ reply: ok('{"route":"view","form":"table"}'), view: ok(JSON.stringify({ table: { columns: ['Element'], rows: [{ cells: ['Account A-1'], cites: ['n1'] }, { cells: ['Account A-2'], cites: ['n2'] }] } })) });
    const result = await run(view, { ...VIEW_BODY, investigationId: INVESTIGATION });
    const answer = 'value' in result ? assistantTurnAnswerSchema.parse(result.value) : undefined;
    if (answer?.status !== 'answered' || answer.route !== 'view' || !('blocks' in answer)) throw new Error('not a table answer');
    const [kept] = stored(view);
    expect(kept).toMatchObject({ route: 'view', outcome: 'answered' });
    expect(kept?.citationRefs).toHaveLength(2);
    expect(kept?.citationRefs).toEqual(answer.citations.flatMap((citation) => (citation.kind === 'description' || citation.kind === 'read' ? [] : [citation.ref])));
    expect(kept?.answer).toEqual({ model: 'fixture-model', coverage: { retrieval: expect.any(String), summary: expect.any(String) }, blocks: [{ kind: 'table', columns: [{ form: 'unbound', text: 'Element' }], rows: tablesOfBlocks(answer.blocks).flatMap((shown) => shown.rows).map((row, index) => ({ cells: [{ form: 'unbound', text: row.cells[0] }], cites: [answer.citations.flatMap((citation) => (citation.kind === 'description' || citation.kind === 'read' ? [] : [citation.ref]))[index]] })) }] });
    const closed = view.r.events.find((event) => event.action === TURN_CLOSED_ACTION);
    expect(closed?.detail).toMatchObject({ turn: { route: 'view', outcome: 'answered', citedElements: 2, form: 'table', tableRowsShown: 2 } });
    expect((closed?.detail as { turn: Record<string, unknown> }).turn).not.toHaveProperty('tableRowsDropped');
    expect((closed?.detail as { turn: Record<string, unknown> }).turn).not.toHaveProperty('tableRowsNotShown');
    // no cell, column label or title in the event
    for (const text of ['Account A-1', '"Element"', 'widgets']) expect(JSON.stringify(closed)).not.toContain(text);
  });

  it('keeps nothing for a turn that failed, was cancelled, was too long or too large, a continue that is not valid, or a person who may not read', async () => {
    for (const code of ['timeout', 'bad-reply'] as const) {
      const failed = await turnRig({ reply: { kind: 'failed', code } });
      await run(failed);
      expect(stored(failed)).toEqual([]);
    }
    const reading = await turnRig({ reply: SHARED, runThrows: new ExtensionRefusal({ code: 'QUERY_TIMEOUT', timeoutMs: 1 }) });
    await run(reading);
    expect(stored(reading)).toEqual([]);
    const controller = new AbortController();
    const cancelled = await turnRig({ reply: SHARED, run: () => new Promise((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new ExtensionRefusal({ code: 'QUERY_TIMEOUT', timeoutMs: 1 })))) });
    const pending = run(cancelled, BASE, { signal: controller.signal });
    await vi.waitFor(() => expect(cancelled.r.runs).toHaveLength(1));
    controller.abort();
    await pending;
    expect(stored(cancelled)).toEqual([]);
    const long = await turnRig({ maxMessageWords: 2 });
    await run(long, { ...BASE, message: 'one two three' });
    const large = await turnRig({ maxInputTokens: 10 });
    await run(large);
    const bad = await turnRig();
    await run(bad, { sourceId: 'demo', investigationId: INVESTIGATION, viewElementKeys: [], continue: { intent: 'shared', entities: { id: 'A-1' }, continueToken: `1.${'a'.repeat(64)}` } });
    const denied = await turnRig({ readable: 'investigation' });
    await run(denied);
    const empty = await turnRig();
    await run(empty, { ...BASE, message: '   ' });
    for (const turn of [long, large, bad, denied, empty]) expect(stored(turn)).toEqual([]);
  });

  it('makes the same keyed hash for the same message, another for another, never the plain digest, and another under another key', async () => {
    const hashes: string[] = [];
    for (const message of ['Which accounts share a device?', 'Which accounts share a device?', 'Another message']) {
      const turn = await turnRig({ reply: ok('{"route":"refuse","cause":"verdict"}') });
      await run(turn, { ...BASE, message });
      hashes.push(stored(turn)[0]?.questionHash ?? '');
    }
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[0]).not.toBe(hashes[2]);
    expect(hashes[0]).not.toBe(createHash('sha256').update('Which accounts share a device?', 'utf8').digest('hex'));
    const turn = await turnRig({ reply: ok('{"route":"refuse","cause":"verdict"}') });
    await turn.r.route.handler({ ...turn.r.request({ ...BASE, message: 'Which accounts share a device?' }, { principalId: PERSON }), signText: (text) => sign(`another key:${text}`) });
    await drain();
    expect(stored(turn)[0]?.questionHash).not.toBe(hashes[0]);
  });

  it('keeps each person’s turns in their own thread of their own investigation, for overlapping turns', async () => {
    const threads = createMemoryAssistantThreadStore();
    const a = await turnRig({ reply: ok('{"route":"refuse","cause":"verdict"}') }, threads);
    const b = await turnRig({ reply: ok('{"route":"refuse","cause":"other-source"}') }, threads);
    await Promise.all([run(a, BASE, { principalId: PERSON }), run(b, { ...BASE, investigationId: SECOND }, { principalId: OTHER })]);
    expect(stored(a, PERSON, INVESTIGATION).map((held) => held.cause)).toEqual(['verdict']);
    expect(stored(b, OTHER, SECOND).map((held) => held.cause)).toEqual(['other-source']);
    expect(stored(a, OTHER, INVESTIGATION)).toEqual([]);
  });
});

describe('the writes of a thread never change a turn and never outlive the investigation', () => {
  const REFUSE = ok('{"route":"refuse","cause":"verdict"}');

  it('writes nothing for a turn that saw its investigation closed, or closed and reopened, while it worked', async () => {
    for (const reopen of [false, true]) {
      const threads = createMemoryAssistantThreadStore();
      const turn = await turnRig({ reply: SHARED, run: () => (threads.clear(INVESTIGATION), reopen && threads.reopen(INVESTIGATION), { status: 'ok', result: okResult() }) }, threads);
      const outcome = await run(turn);
      expect('value' in outcome && outcome.value).toMatchObject({ status: 'answered', route: 'ask' });
      expect(stored(turn)).toEqual([]);
      expect(turn.queue.failed).toEqual([]);
    }
  });

  it('does no work until the epoch is read, takes the epoch of a lifecycle that changed while it waited, and writes into that lifecycle', async () => {
    const threads = createMemoryAssistantThreadStore();
    const held = { release: (): void => undefined };
    const waiting = new Promise<void>((resolve) => (held.release = resolve));
    const delayed: AssistantThreadStore = { ...threads, epoch: async (id) => (await waiting, threads.epoch(id)) };
    const r = await rig({ reply: REFUSE, threadStore: delayed, records: queue().records });
    const pending = r.route.handler(r.request(BASE, { principalId: PERSON }));
    await drain();
    expect(r.fixture.calls).toHaveLength(0);
    threads.clear(INVESTIGATION);
    threads.reopen(INVESTIGATION);
    held.release();
    await pending;
    await drain();
    expect(r.fixture.calls).toHaveLength(1);
    expect(threads.threads.get(`${INVESTIGATION}:${PERSON}`)?.turns).toHaveLength(1);
  });

  it('writes nothing for a turn whose epoch cannot be read, counts the failure by turn id and step, and answers as before', async () => {
    const records = queue();
    const failing = await turnRig({ reply: REFUSE }, createMemoryAssistantThreadStore({ failOn: 'epoch' }), records);
    const plain = await rig({ reply: REFUSE });
    const outcome = await run(failing);
    expect('value' in outcome && outcome.value).toEqual(await answerOf(plain.route.handler(plain.request(BASE, { principalId: PERSON }))));
    expect(stored(failing)).toEqual([]);
    expect(records.failed).toEqual([{ turnId: expect.stringMatching(/^[0-9a-f-]{36}$/), step: 'epoch' }]);
  });

  it('refuses a write the schema does not accept before any statement, counts it as a failed build and answers as before', async () => {
    const records = queue();
    const turn = await turnRig({ reply: REFUSE }, createMemoryAssistantThreadStore(), records);
    const outcome = await run(turn, BASE, { principalId: 'not-a-uuid' });
    expect('value' in outcome && outcome.value).toMatchObject({ status: 'answered', route: 'refuse' });
    expect(stored(turn, 'not-a-uuid')).toEqual([]);
    expect(records.failed).toEqual([{ turnId: expect.any(String), step: 'build' }]);
  });

  it.each([
    ['a store that fails', createMemoryAssistantThreadStore({ failOn: 'append' }), 'failed'],
  ] as const)('answers, writes the audit events and the run record as before, and counts the write, for %s', async (_name, threads, kind) => {
    const records = queue();
    const runs = createMemoryAssistantRunStore();
    const failing = await turnRig({ reply: SHARED, runStore: runs }, threads, records);
    const plainRuns = createMemoryAssistantRunStore();
    const plain = await rig({ reply: SHARED, runStore: plainRuns });
    const outcome = await run(failing);
    expect('value' in outcome && outcome.value).toEqual(await answerOf(plain.route.handler(plain.request(BASE, { principalId: PERSON }))));
    expect(failing.r.events.filter((event) => event.action === TURN_CLOSED_ACTION)).toHaveLength(1);
    expect(runs.runs[0]).toMatchObject({ outcome: 'answered', calls: 1 });
    expect(records[kind]).toEqual([{ turnId: expect.any(String), step: 'append' }]);
  });

  it('does not wait for a store that never answers, and counts a write the queue cannot hold as dropped', async () => {
    const never = new Promise<AssistantThreadTurnWrite['route']>(() => undefined);
    const threads = createMemoryAssistantThreadStore();
    const stuck: AssistantThreadStore = { ...threads, append: () => never.then(() => 'stored' as const) };
    const full = queue(0);
    const turn = await turnRig({ reply: REFUSE }, stuck as MemoryAssistantThreadStore, full);
    const outcome = await run(turn);
    expect('value' in outcome && outcome.value).toMatchObject({ status: 'answered' });
    expect(full.dropped).toEqual([{ turnId: expect.any(String), step: 'append' }]);
    const holding = await turnRig({ reply: REFUSE }, stuck as MemoryAssistantThreadStore, queue());
    expect('value' in (await run(holding))).toBe(true);
  });

  it('is safe to write twice: a retried job leaves one turn', async () => {
    const threads = createMemoryAssistantThreadStore();
    const records = queue();
    const turn = await turnRig({ reply: REFUSE }, threads, records);
    await run(turn);
    await records.jobs.find((job) => job.ids['step'] === 'append')?.write();
    expect(stored(turn)).toHaveLength(1);
  });

  it.each([[true, 'frozen'], [false, 'unbound']] as const)('keeps every item of an answer written with the mask %s in the form %s, with the mask state of the request', async (mask, form) => {
    const view = await turnRig({ reply: ok('{"route":"view","form":"table"}'), view: ok(JSON.stringify({ table: { columns: ['Element'], rows: [{ cells: ['Account A-1'], cites: ['n1'] }] } })) });
    await run(view, { ...VIEW_BODY, investigationId: INVESTIGATION, mask });
    const [kept] = stored(view);
    expect(kept?.maskOn).toBe(mask);
    const forms = (kept?.answer?.blocks ?? []).flatMap((block) => (block.kind === 'table' ? block.rows.flatMap((row) => row.cells.map((cell) => cell.form)) : []));
    expect(forms.length).toBeGreaterThan(0);
    expect(new Set(forms)).toEqual(new Set([form]));
  });

  describe('an answer written with the mask off, classified by the sensitive values sent', () => {
    const TITLES = { sensitiveKeys: () => new Map([['widget', ['(title)']]]), sensitivityVersion: () => 'sv1:abc' } as const;
    const answerOf_ = async (over: Partial<ExtensionRequest>, body: Record<string, unknown>, reply: unknown) => {
      const view = await turnRig({ reply: ok(JSON.stringify({ route: 'view', ...(typeof reply === 'object' && reply !== null && 'table' in reply ? { form: 'table' } : {}) })), view: ok(JSON.stringify(reply)) });
      await run(view, { ...VIEW_BODY, investigationId: INVESTIGATION, ...body }, over);
      return stored(view)[0];
    };
    const sentence = (text: string, cites: string[] = ['n1']) => ({ sentences: [{ text, cites }] });

    it('stores a sentence that holds a sensitive value as the whole value of one cited element as segments, with no value in its bytes, and the version of the classification', async () => {
      const kept = await answerOf_(TITLES, {}, sentence('Account A-1 is listed.'));
      const item = kept?.answer?.blocks[0]?.kind === 'sentences' ? kept.answer.blocks[0].items[0] : undefined;
      expect(item).toMatchObject({ form: 'bound', segments: [{ element: { stableId: 'A-1' }, property: '(title)' }, { literal: ' is listed.' }] });
      expect(JSON.stringify(kept?.answer)).not.toContain('Account A-1');
      expect(kept?.sensitivityVersion).toBe('sv1:abc');
    });

    it('stores the whole sentence as written, flagged, when one value cannot be bound (the title of an element it does not cite), with no partial binding', async () => {
      const kept = await answerOf_(TITLES, {}, sentence('Account A-1 and Account A-2 are listed.'));
      expect(kept?.answer?.blocks[0]).toMatchObject({ kind: 'sentences', items: [{ form: 'unbound', text: 'Account A-1 and Account A-2 are listed.' }] });
    });

    it('stores a sentence with no sensitive value frozen, a table cell by the same rule as a sentence, and every item frozen when the mask was on', async () => {
      const plain = await answerOf_({ ...TITLES, sensitiveKeys: () => new Map() }, {}, sentence('Account A-1 is listed.'));
      expect(plain?.answer?.blocks[0]).toMatchObject({ items: [{ form: 'frozen' }] });
      const table = { table: { columns: ['Element'], rows: [{ cells: ['Account A-1'], cites: ['n1'] }] } };
      const cell = await answerOf_(TITLES, {}, table);
      expect(cell?.answer?.blocks[0]).toMatchObject({ kind: 'table', columns: [{ form: 'frozen', text: 'Element' }], rows: [{ cells: [{ form: 'bound', segments: [{ element: { stableId: 'A-1' }, property: '(title)' }] }] }] });
      const masked = await answerOf_(TITLES, { mask: true }, sentence('Account A-1 is listed.'));
      expect(masked?.answer?.blocks[0]).toMatchObject({ items: [{ form: 'frozen', text: 'Account A-1 is listed.' }] });
      expect(masked?.sensitivityVersion).toBe('sv1:abc');
    });

    it('stores an answer written after tool steps the same way, bound to the element a read listed, and unbound when the answer is not the one the provenance was kept for', async () => {
      const steps = () => { let next = 0; const replies = [ok(JSON.stringify({ tool: 'byId', values: { id: 'A-2' } })), ok('{"done":true}')]; return () => replies[Math.min(next++, replies.length - 1)] ?? ok('{"done":true}'); };
      const tools = await turnRig({ reply: SHARED, step: steps(), run: () => ({ status: 'ok', result: okResult() }), answer: ok(JSON.stringify({ sentences: [{ text: 'Account A-1 is listed.', cites: ['r1'] }] })) });
      await run(tools, BASE, TITLES);
      const kept = stored(tools)[0];
      const item = kept?.answer?.blocks[0]?.kind === 'sentences' ? kept.answer.blocks[0].items[0] : undefined;
      expect(item).toMatchObject({ form: 'bound', segments: [{ element: { stableId: 'A-1' }, property: '(title)' }, { literal: ' is listed.' }] });
      expect(JSON.stringify(kept?.answer)).not.toContain('Account A-1');
      // a keys-and-version pair read across a change of the mapping is not used
      let reads = 0;
      const moving = await turnRig({ reply: SHARED, step: steps(), run: () => ({ status: 'ok', result: okResult() }), answer: ok(JSON.stringify({ sentences: [{ text: 'Account A-1 is listed.', cites: ['r1'] }] })) });
      await run(moving, BASE, { sensitiveKeys: TITLES.sensitiveKeys, sensitivityVersion: () => `sv1:${(reads += 1)}` });
      expect(stored(moving)[0]?.answer?.blocks[0]).toMatchObject({ items: [{ form: 'unbound' }] });
      expect(stored(moving)[0]).not.toHaveProperty('sensitivityVersion');
    });

    it('stores every item unbound, and no version, when the capability is absent or fails', async () => {
      const absent = await answerOf_({}, {}, sentence('Account A-1 is listed.'));
      expect(absent?.answer?.blocks[0]).toMatchObject({ items: [{ form: 'unbound', text: 'Account A-1 is listed.' }] });
      expect(absent).not.toHaveProperty('sensitivityVersion');
      const failing = await answerOf_({ sensitiveKeys: () => { throw new Error('down'); }, sensitivityVersion: () => { throw new Error('down'); } }, {}, sentence('Account A-1 is listed.'));
      expect(failing?.answer?.blocks[0]).toMatchObject({ items: [{ form: 'unbound' }] });
    });
  });

  it('keeps the question as typed and the answer in the thread, and no entity value, instruction or reply, and no text in any event of the turn', async () => {
    const CANARY = 'CANARY-MESSAGE-7';
    const turn = await turnRig({ reply: SHARED, run: () => ({ status: 'ok', result: okResult() }) });
    const outcome = await run(turn, { ...BASE, message: `Show ${CANARY} A-1`, viewElementKeys: ['key-canary-9'] });
    const [kept] = stored(turn);
    expect(kept?.question).toBe(`Show ${CANARY} A-1`);
    expect(kept?.maskOn).toBe(false);
    const rows = JSON.stringify(stored(turn).map((held) => ({ ...held, at: undefined, question: undefined, answer: undefined })));
    for (const canary of [CANARY, 'key-canary-9', 'Choose the intent that answers the question', 'You route messages', 'Show ']) expect(rows, canary).not.toContain(canary);
    expect(outcome).toBeDefined();
    expect(turn.r.events.map((event) => auditDetailSchema.parse(event.detail)).length).toBeGreaterThan(0);
    expect(JSON.stringify(turn.r.events)).not.toContain(CANARY);
  });
});

describe('the id of a turn that the panel gave', () => {
  const TURN_ID = '0192f000-0000-7000-8000-0000000000c1';
  const OTHER = '0192f000-0000-7000-8000-000000000002';
  const body = (over: Record<string, unknown> = {}) => ({ ...VIEW_BODY, investigationId: INVESTIGATION, turnId: TURN_ID, ...over });
  const view = () => turnRig({ view: ok(JSON.stringify({ sentences: [{ text: 'Account A-1 and account A-2 are in view.', cites: ['n1', 'n2'] }] })) });

  it('writes the turn under the id its request carried, and the read of the thread tells the panel that id', async () => {
    const turn = await view();
    await run(turn, body());
    expect(stored(turn).map((kept) => kept.id)).toEqual([TURN_ID]);
    const read = await turn.threads.read(INVESTIGATION, PERSON, 10);
    expect(read.turns.map((entry) => entry.id)).toEqual([TURN_ID]);
  });

  it('gives a turn whose request carried no id an id of its own, and reads it the same way', async () => {
    const turn = await view();
    await run(turn, { ...VIEW_BODY, investigationId: INVESTIGATION });
    const [kept] = stored(turn);
    expect(kept?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await turn.threads.read(INVESTIGATION, PERSON, 10)).turns[0]?.id).toBe(kept?.id);
  });

  it('writes one turn when the same request is tried again, and refuses an id another person or another investigation already holds, before anything is read or asked, and writes nothing for it', async () => {
    const turn = await view();
    await run(turn, body());
    const again = await run(turn, body());
    expect('value' in again).toBe(true);
    expect(stored(turn)).toHaveLength(1);
    const takenByOther = await run(turn, body(), { principalId: OTHER });
    expect('error' in takenByOther ? (takenByOther.error as { code?: string }).code : undefined).toBe('INVALID_REQUEST');
    expect(stored(turn, OTHER)).toEqual([]);
    const takenElsewhere = await run(turn, body({ investigationId: '0192f000-0000-7000-8000-0000000000b2' }));
    expect('error' in takenElsewhere ? (takenElsewhere.error as { code?: string }).code : undefined).toBe('INVALID_REQUEST');
    expect(stored(turn)).toHaveLength(1);
  });

  it('answers a turn as before when the store cannot say whether the id is taken', async () => {
    const threads = createMemoryAssistantThreadStore({ failOn: 'epoch' });
    const turn = await turnRig({ view: ok(JSON.stringify({ sentences: [{ text: 'Account A-1 and account A-2 are in view.', cites: ['n1', 'n2'] }] })) }, threads);
    const result = await run(turn, body());
    expect('value' in result).toBe(true);
  });
});
