import { type AssistantThreadTurnWrite, type AuditSinkContext } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { AssistantThreadOutcomeUnknownError, AssistantThreadStoreError, createMemoryAssistantThreadStore, createPgAssistantThreadStore, type ThreadClient, type ThreadPool } from './thread-store.js';

const CONTEXT: AuditSinkContext = { databaseUrl: 'postgres://app@db.example.test/neburyx', poolSize: 1, connectionTimeoutMs: 1000, statementTimeoutMs: 1000, queryTimeoutMs: 1000, newId: () => '00000000-0000-7000-8000-000000000000', onConnectionError: () => undefined };
const INVESTIGATION = '0192f000-0000-7000-8000-0000000000a1';
const OWNER = '0192f000-0000-7000-8000-000000000001';
const OTHER = '0192f000-0000-7000-8000-000000000002';
const HASH = 'a'.repeat(64);

const turn = (over: Partial<AssistantThreadTurnWrite> = {}): AssistantThreadTurnWrite => ({
  id: crypto.randomUUID(),
  investigationId: INVESTIGATION,
  userId: OWNER,
  at: new Date('2026-11-18T10:00:00Z'),
  route: 'ask',
  outcome: 'answered',
  questionHash: HASH,
  entities: [],
  citationRefs: [],
  steps: 1,
  ...over,
});

interface Script {
  readonly status?: string;
  readonly epoch?: number;
  readonly exists?: boolean;
  readonly failAt?: RegExp;
  readonly inserted?: number;
  readonly turns?: readonly Record<string, unknown>[];
  readonly total?: number;
  readonly cleared?: Date;
  readonly hasThread?: boolean;
  readonly deleted?: number;
  readonly listed?: readonly Record<string, unknown>[];
}

function pool(script: Script = {}) {
  const statements: string[] = [];
  const released = { count: 0 };
  const parameters: (readonly unknown[] | undefined)[] = [];
  const client: ThreadClient = {
    async query(text, values) {
      statements.push(text);
      parameters.push(values);
      if (script.failAt?.test(text) === true) throw new Error('DRIVER-TEXT canary-secret-7f3 INSERT INTO ...');
      if (/FOR NO KEY UPDATE/.test(text)) return { rows: script.status === 'none' ? [] : [{ '?column?': 1 }] };
      if (/FOR SHARE/.test(text)) return { rows: script.status === 'none' ? [] : [{ status: script.status ?? 'open', deleted: false }] };
      if (/FROM assistant_investigation_epochs/.test(text)) return { rows: script.epoch === undefined ? [] : [{ epoch: script.epoch }] };
      if (/SELECT 1 FROM assistant_turns/.test(text)) return { rows: script.exists === true ? [{ '?column?': 1 }] : [] };
      if (/^SELECT h\.id, h\.investigation_id/.test(text)) return { rows: script.listed ?? [] };
      if (/^DELETE FROM assistant_threads/.test(text)) return { rows: [], rowCount: script.deleted ?? 1 };
      if (/INSERT INTO assistant_threads/.test(text)) return { rows: [{ id: 'thread-1' }] };
      if (/MAX\(seq\)/.test(text)) return { rows: [{ seq: 3 }] };
      if (/INSERT INTO assistant_turns/.test(text)) return { rows: [], rowCount: script.inserted ?? 1 };
      if (/ORDER BY t.seq DESC/.test(text)) return { rows: script.turns ?? [] };
      if (/count\(\*\)::int/.test(text)) return { rows: [{ n: script.total ?? script.turns?.length ?? 0 }] };
      if (/SELECT 1 FROM assistant_threads/.test(text)) return { rows: script.hasThread === false ? [] : [{ '?column?': 1 }] };
      if (/FROM assistant_thread_clears/.test(text)) return { rows: script.cleared === undefined ? [] : [{ cleared_at: script.cleared }] };
      return { rows: [], rowCount: 0 };
    },
    release: () => void (released.count += 1),
  };
  const held: ThreadPool = { connect: async () => client, end: async () => undefined, on: () => undefined };
  return { held, statements, released, parameters };
}

describe('the Postgres store of the threads', () => {
  it('writes a turn in one transaction: the investigation is locked first, the epoch is checked, the thread is created or locked, the sequence follows it', async () => {
    const { held, statements, released } = pool({ epoch: 2 });
    const store = createPgAssistantThreadStore(CONTEXT, { createPool: () => held });
    expect(await store.append(turn(), 2)).toBe('stored');
    expect(statements.map((text) => text.split(' ').slice(0, 4).join(' '))).toEqual(['BEGIN', 'SELECT status, deleted_at IS', 'SELECT COALESCE((SELECT epoch FROM', 'SELECT 1 FROM assistant_turns', 'INSERT INTO assistant_threads (id,', 'SELECT COALESCE(MAX(seq), 0) +', 'INSERT INTO assistant_turns (id,', 'COMMIT']);
    expect(statements[1]).toContain('FOR SHARE');
    expect(statements[4]).toContain('ON CONFLICT (investigation_id, user_id) DO UPDATE SET last_turn_at = GREATEST');
    expect(statements[6]).toContain('ON CONFLICT (id) DO NOTHING');
    expect(released.count).toBe(1);
  });

  it.each([
    ['a closed investigation', { status: 'closed', epoch: 0 }, 0],
    ['an investigation that is not there', { status: 'none', epoch: 0 }, 0],
    ['another epoch', { status: 'open', epoch: 1 }, 0],
  ] as const)('refuses a turn for %s, rolls back and writes nothing', async (_name, script, epoch) => {
    const { held, statements } = pool(script);
    const store = createPgAssistantThreadStore(CONTEXT, { createPool: () => held });
    expect(await store.append(turn(), epoch)).toBe('refused');
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements.some((text) => /INSERT INTO assistant_(threads|turns)/.test(text))).toBe(false);
  });

  it('answers duplicate, with nothing written, for a turn that is already there and for one whose insert took no row', async () => {
    const there = pool({ exists: true });
    expect(await createPgAssistantThreadStore(CONTEXT, { createPool: () => there.held }).append(turn(), 0)).toBe('duplicate');
    expect(there.statements.some((text) => /INSERT INTO assistant_/.test(text))).toBe(false);
    const raced = pool({ inserted: 0 });
    expect(await createPgAssistantThreadStore(CONTEXT, { createPool: () => raced.held }).append(turn(), 0)).toBe('duplicate');
  });

  it('answers the fixed error, with no driver text, for a failing statement, rolls the transaction back and releases the connection', async () => {
    const { held, statements, released } = pool({ failAt: /MAX\(seq\)/ });
    const store = createPgAssistantThreadStore(CONTEXT, { createPool: () => held });
    const error = await store.append(turn(), 0).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(AssistantThreadStoreError);
    expect(JSON.stringify([(error as Error).message, (error as Error & { code: string }).code])).not.toMatch(/DRIVER-TEXT|canary-secret-7f3/);
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(released.count).toBe(1);
  });

  it('answers the fixed error when no connection can be made, and refuses a turn the schema does not accept before any statement', async () => {
    const down: ThreadPool = { connect: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.1')), end: async () => undefined, on: () => undefined };
    await expect(createPgAssistantThreadStore(CONTEXT, { createPool: () => down }).epoch(INVESTIGATION, OWNER)).rejects.toBeInstanceOf(AssistantThreadStoreError);
    const { held, statements } = pool();
    await expect(createPgAssistantThreadStore(CONTEXT, { createPool: () => held }).append({ ...turn(), questionHash: 'not-a-hash' }, 0)).rejects.toBeInstanceOf(AssistantThreadStoreError);
    expect(statements).toEqual([]);
  });

  it('reads the epoch as 0 when the investigation was never cleared', async () => {
    const { held } = pool();
    expect(await createPgAssistantThreadStore(CONTEXT, { createPool: () => held }).epoch(INVESTIGATION, OWNER)).toBe(0);
    const cleared = pool({ epoch: 4 });
    expect(await createPgAssistantThreadStore(CONTEXT, { createPool: () => cleared.held }).epoch(INVESTIGATION, OWNER)).toBe(4);
  });

  it('closes its pool once', async () => {
    let ended = 0;
    const counted: ThreadPool = { connect: async () => pool().held.connect(), end: async () => void (ended += 1), on: () => undefined };
    const store = createPgAssistantThreadStore(CONTEXT, { createPool: () => counted });
    await store.close();
    await store.close();
    expect(ended).toBe(1);
  });
});

const SENTENCE = (over: Record<string, unknown> = {}) => ({ form: 'unbound', text: 'Account A-1 is listed.', cites: [], ...over });
const ANSWER = { blocks: [{ kind: 'sentences', items: [SENTENCE()] }] };

describe('the text of a turn, stored through the strict schema', () => {
  it('writes the question, the mask state, the answer and the version in four columns of the one insert, and null for a turn that has none', async () => {
    const { held, statements, parameters } = pool();
    const store = createPgAssistantThreadStore(CONTEXT, { createPool: () => held });
    await store.append(turn({ question: 'Which accounts?', maskOn: true, answer: ANSWER as never }), 0);
    const bound = parameters[statements.findIndex((text) => /INSERT INTO assistant_turns/.test(text))] ?? [];
    expect(bound.slice(18)).toEqual(['Which accounts?', true, JSON.stringify(ANSWER), null]);
    const insert = statements.find((text) => /INSERT INTO assistant_turns/.test(text)) ?? '';
    expect(insert).toContain('question_text, mask_on, answer, sensitivity_version');
    const bare = pool();
    await createPgAssistantThreadStore(CONTEXT, { createPool: () => bare.held }).append(turn(), 0);
    expect(bare.statements.some((text) => /INSERT INTO assistant_turns/.test(text))).toBe(true);
  });

  it('hands the database the segments of a bound item and none of its values', async () => {
    const bound = { blocks: [{ kind: 'sentences', items: [{ form: 'bound', segments: [{ element: { sourceId: 'demo', entityType: 'widget', stableId: 'A-1' }, property: 'holder' }, { literal: ' is listed.' }], cites: [{ sourceId: 'demo', entityType: 'widget', stableId: 'A-1' }] }] }] };
    const { held, statements, parameters } = pool();
    await createPgAssistantThreadStore(CONTEXT, { createPool: () => held }).append(turn({ question: 'Who?', maskOn: false, answer: bound as never }), 0);
    const bytes = String(parameters[statements.findIndex((text) => /INSERT INTO assistant_turns/.test(text))]?.[20]);
    expect(bytes).toContain('"property":"holder"');
    expect(bytes).not.toContain('Jordan');
  });

  it.each([
    ['a question one over the bound', { maskOn: false, question: 'q'.repeat(4001) }],
    ['a sentence one over the bound', { maskOn: false, answer: { blocks: [{ kind: 'sentences', items: [SENTENCE({ text: 's'.repeat(2001) })] }] } }],
    ['a cell one over the bound', { maskOn: false, answer: { blocks: [{ kind: 'table', columns: [{ form: 'unbound', text: 'A' }], rows: [{ cells: [{ form: 'unbound', text: 'c'.repeat(81) }], cites: [] }] }] } }],
    ['a member the schema does not name', { maskOn: false, answer: { blocks: [{ kind: 'sentences', items: [SENTENCE({ token: 'T' })] }] } }],
    ['an extra key beside the blocks', { maskOn: false, answer: { blocks: [{ kind: 'sentences', items: [SENTENCE()] }], runId: 'x' } }],
    ['a form that is not one', { maskOn: false, answer: { blocks: [{ kind: 'sentences', items: [SENTENCE({ form: 'bound' })] }] } }],
    ['text on a waiting turn', { outcome: 'waiting', question: 'Which accounts?', maskOn: false }],
    ['text with no state of the mask', { question: 'Which accounts?' }],
    ['a row with fewer cells than columns', { maskOn: false, answer: { blocks: [{ kind: 'table', columns: [{ form: 'unbound', text: 'A' }, { form: 'unbound', text: 'B' }], rows: [{ cells: [{ form: 'unbound', text: 'x' }], cites: [] }] }] } }],
  ])('refuses %s as a whole before any statement', async (_name, over) => {
    const { held, statements } = pool();
    const store = createPgAssistantThreadStore(CONTEXT, { createPool: () => held });
    await expect(store.append(turn(over as never), 0)).rejects.toBeInstanceOf(Error);
    expect(statements.filter((text) => /INSERT/.test(text))).toEqual([]);
    const memory = createMemoryAssistantThreadStore();
    await expect(memory.append(turn(over as never), 0)).rejects.toBeInstanceOf(Error);
    expect(memory.threads.size).toBe(0);
  });

  it('keeps the text at its bounds, and the memory store keeps it in the stored form', async () => {
    const memory = createMemoryAssistantThreadStore();
    const edge = turn({ maskOn: false, question: 'q'.repeat(4000), answer: { blocks: [{ kind: 'sentences', items: [SENTENCE({ text: 's'.repeat(2000) })] }] } as never });
    expect(await memory.append(edge, 0)).toBe('stored');
    expect([...memory.threads.values()][0]?.turns[0]?.question).toHaveLength(4000);
    const { held, statements, parameters } = pool();
    expect(await createPgAssistantThreadStore(CONTEXT, { createPool: () => held }).append(edge, 0)).toBe('stored');
    const bound = parameters[statements.findIndex((text) => /INSERT INTO assistant_turns/.test(text))] ?? [];
    expect(String(bound[18])).toHaveLength(4000);
  });
});

describe('the read of the Postgres store', () => {
  const row = (seq: number) => ({ id: `0192f000-0000-7000-8000-0000000000${String(seq).padStart(2, '0')}`, seq, at: new Date('2026-11-18T10:00:00Z'), route: 'ask', outcome: 'answered', cause: null, intent: 'widgetById', steps: 1, cited: 2 });

  it('reads in one repeatable-read, read-only transaction, the newest turns first so the oldest are the ones left out, and answers them oldest first with how many are not shown', async () => {
    const { held, statements, released } = pool({ turns: [row(7), row(6)], total: 7 });
    const answer = await createPgAssistantThreadStore(CONTEXT, { createPool: () => held }).read(INVESTIGATION, OWNER, 100);
    expect(statements[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements.slice(1, -1).every((text) => text.startsWith('SELECT'))).toBe(true);
    expect(statements[1]).toContain('ORDER BY t.seq DESC LIMIT $3');
    expect(answer).toEqual({ turns: [expect.objectContaining({ seq: 6 }), expect.objectContaining({ seq: 7, intent: 'widgetById', citedElements: 2 })], earlierTurns: 5, previousThreadClearedAt: null, epoch: 0 });
    expect(released.count).toBe(1);
  });

  it('says when the person’s thread was cleared only when they have no thread since, and rolls back and answers the fixed error when a read fails', async () => {
    const cleared = pool({ turns: [], hasThread: false, cleared: new Date('2026-11-18T12:00:00Z'), epoch: 3 });
    expect(await createPgAssistantThreadStore(CONTEXT, { createPool: () => cleared.held }).read(INVESTIGATION, OWNER, 100)).toEqual({ turns: [], earlierTurns: 0, previousThreadClearedAt: '2026-11-18T12:00:00.000Z', epoch: 3 });
    const since = pool({ turns: [row(1)], hasThread: true, cleared: new Date('2026-11-18T12:00:00Z') });
    expect((await createPgAssistantThreadStore(CONTEXT, { createPool: () => since.held }).read(INVESTIGATION, OWNER, 100)).previousThreadClearedAt).toBeNull();
    const failing = pool({ failAt: /count\(\*\)/ });
    await expect(createPgAssistantThreadStore(CONTEXT, { createPool: () => failing.held }).read(INVESTIGATION, OWNER, 100)).rejects.toBeInstanceOf(AssistantThreadStoreError);
    expect(failing.statements.at(-1)).toBe('ROLLBACK');
  });
});

describe('the read of the context of the Postgres store', () => {
  it('reads the caller’s own turns of the investigation in one statement, newest first and bounded, and answers them oldest first with their references', async () => {
    const entities = [{ role: 'id', ref: { sourceId: 'demo', entityType: 'widget', stableId: 'A-1' } }];
    const { held, statements } = pool({ turns: [{ route: 'refuse', outcome: 'refused', cause: 'verdict', intent: null, entities: [], citation_refs: [] }, { route: 'ask', outcome: 'answered', cause: null, intent: 'one', entities, citation_refs: [] }] });
    const read = await createPgAssistantThreadStore(CONTEXT, { createPool: () => held }).readContext(INVESTIGATION, OWNER, 3);
    expect(read).toEqual([{ route: 'ask', outcome: 'answered', intent: 'one', entities, citationRefs: [] }, { route: 'refuse', outcome: 'refused', cause: 'verdict', entities: [], citationRefs: [] }]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/h\.investigation_id = \$1 AND h\.user_id = \$2 ORDER BY t\.seq DESC LIMIT \$3/);
  });

  it('answers the fixed error, with no driver text, for a failing statement', async () => {
    const { held } = pool({ failAt: /ORDER BY t.seq DESC/ });
    const error = await createPgAssistantThreadStore(CONTEXT, { createPool: () => held }).readContext(INVESTIGATION, OWNER, 3).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AssistantThreadStoreError);
    expect(JSON.stringify(error) + String(error)).not.toContain('canary-secret-7f3');
  });
});

describe('the text of the turns a Postgres read hands on', () => {
  const rowOf = (seq: number, over: Record<string, unknown>) => ({ id: `0192f000-0000-7000-8000-0000000000${String(seq).padStart(2, '0')}`, seq, at: new Date('2026-11-18T10:00:00Z'), route: 'ask', outcome: 'answered', cause: null, intent: null, steps: 1, cited: 0, question_text: null, mask_on: null, answer: null, sensitivity_version: null, ...over });

  it('hands each turn its own text in the order of the turns, drops an answer that is not the stored form or not JSON and keeps its question, and none for a row with the four columns null', async () => {
    const good = { blocks: [{ kind: 'sentences', items: [{ form: 'frozen', text: 'Fixed text.', cites: [] }] }] };
    const { held } = pool({ turns: [rowOf(4, { question_text: 'Third?', mask_on: false, answer: good, sensitivity_version: 'sv1:a' }), rowOf(3, { question_text: 'Second?', mask_on: true, answer: JSON.stringify({ blocks: 'not an answer' }) }), rowOf(2, {}), rowOf(1, { question_text: 'Zero?', mask_on: false, answer: 'not json' })] });
    const read = await createPgAssistantThreadStore(CONTEXT, { createPool: () => held }).read(INVESTIGATION, OWNER, 10);
    // the rows come newest first and are given oldest first
    expect(read.turns.map((held) => held.stored)).toEqual([{ question: 'Zero?', maskOn: false }, undefined, { question: 'Second?', maskOn: true }, { question: 'Third?', maskOn: false, answer: good, sensitivityVersion: 'sv1:a' }]);
  });
});

describe('the context a turn is given', () => {
  it('holds the references the thread keeps and no stored question or answer text, for the memory store and the statement of the Postgres store', async () => {
    const memory = createMemoryAssistantThreadStore();
    await memory.append(turn({ question: 'SENTINEL-QUESTION', maskOn: false, answer: { blocks: [{ kind: 'sentences', items: [{ form: 'unbound', text: 'SENTINEL-ANSWER', cites: [] }] }] } as never }), 0);
    const context = await memory.readContext(INVESTIGATION, OWNER, 10);
    expect(context).toHaveLength(1);
    expect(JSON.stringify(context)).not.toMatch(/SENTINEL/u);
    // canary: a context that carried the text would show it
    expect(JSON.stringify([{ ...context[0], question: 'SENTINEL-QUESTION' }])).toMatch(/SENTINEL/u);
    const { held, statements } = pool({ turns: [] });
    await createPgAssistantThreadStore(CONTEXT, { createPool: () => held }).readContext(INVESTIGATION, OWNER, 5);
    expect(statements.filter((text) => /FROM assistant_turns/.test(text)).join('\n')).not.toMatch(/question_text|\banswer\b|mask_on|sensitivity_version/u);
  });
});

describe('the read of the context of the memory store', () => {
  it('gives the caller’s own last turns oldest first, and none for a person with no thread', async () => {
    const store = createMemoryAssistantThreadStore();
    for (const held of [turn({ intent: 'one' }), turn({ intent: 'two' }), turn({ intent: 'three' }), turn({ userId: OTHER, intent: 'theirs' })]) await store.append(held, 0);
    expect((await store.readContext(INVESTIGATION, OWNER, 2)).map((held) => held.intent)).toEqual(['two', 'three']);
    expect(await store.readContext(INVESTIGATION, '0192f000-0000-7000-8000-0000000000ff', 2)).toEqual([]);
  });
});

describe('the memory store of the threads', () => {
  it('appends in order, per person, writes a turn once, and reads only the caller’s own thread', async () => {
    const store = createMemoryAssistantThreadStore();
    const first = turn();
    expect(await store.append(first, 0)).toBe('stored');
    expect(await store.append(first, 0)).toBe('duplicate');
    expect(await store.append(turn({ route: 'refuse', outcome: 'refused', cause: 'verdict' }), 0)).toBe('stored');
    expect(await store.append(turn({ userId: OTHER }), 0)).toBe('stored');
    expect((await store.read(INVESTIGATION, OWNER, 100)).turns.map((held) => [held.seq, held.route])).toEqual([[1, 'ask'], [2, 'refuse']]);
    expect((await store.read(INVESTIGATION, OTHER, 100)).turns).toHaveLength(1);
  });

  it('clears like the trigger, moves the epoch, refuses a turn of the old epoch after a reopen, and says when the person’s thread was cleared', async () => {
    const store = createMemoryAssistantThreadStore({ now: () => new Date('2026-11-18T12:00:00Z') });
    await store.append(turn(), 0);
    store.clear(INVESTIGATION);
    expect(await store.epoch(INVESTIGATION, OWNER)).toBe(1);
    expect(await store.append(turn(), 0)).toBe('refused');
    store.reopen(INVESTIGATION);
    expect(await store.append(turn(), 0)).toBe('refused');
    expect(await store.read(INVESTIGATION, OWNER, 100)).toEqual({ turns: [], earlierTurns: 0, previousThreadClearedAt: '2026-11-18T12:00:00.000Z', epoch: 1 });
    expect((await store.read(INVESTIGATION, OTHER, 100)).previousThreadClearedAt).toBeNull();
    expect(await store.append(turn(), 1)).toBe('stored');
    expect((await store.read(INVESTIGATION, OWNER, 100)).previousThreadClearedAt).toBeNull();
  });

  it('gives the newest turns up to the bound, in order, and counts the older ones it leaves out, trimming nothing it keeps', async () => {
    const store = createMemoryAssistantThreadStore();
    for (let index = 0; index < 10; index += 1) await store.append(turn(), 0);
    const answer = await store.read(INVESTIGATION, OWNER, 7);
    expect(answer.turns).toHaveLength(7);
    expect([answer.turns[0]?.seq, answer.turns.at(-1)?.seq, answer.earlierTurns]).toEqual([4, 10, 3]);
    expect(store.threads.get(`${INVESTIGATION}:${OWNER}`)?.turns).toHaveLength(10);
    expect((await store.read(INVESTIGATION, OWNER, 500)).earlierTurns).toBe(0);
  });

  it('refuses a turn the schema does not accept and fails at the step it is told to', async () => {
    await expect(createMemoryAssistantThreadStore().append({ ...turn(), questionHash: 'x' }, 0)).rejects.toThrow();
    for (const step of ['epoch', 'append', 'read'] as const) {
      const failing = createMemoryAssistantThreadStore({ failOn: step });
      const work = step === 'epoch' ? failing.epoch(INVESTIGATION, OWNER) : step === 'append' ? failing.append(turn(), 0) : failing.read(INVESTIGATION, OWNER, 100);
      await expect(work).rejects.toBeInstanceOf(AssistantThreadStoreError);
    }
  });
});

describe('the clearing of the caller’s own thread by the Postgres store', () => {
  it('deletes the thread, blanks the call text of the caller’s runs of the investigation, forgets the caller’s clearing notice, all in one transaction, and says a thread was deleted', async () => {
    const { held, statements, parameters, released } = pool({ deleted: 1 });
    const store = createPgAssistantThreadStore(CONTEXT, { createPool: () => held });
    expect(await store.clearOwn(INVESTIGATION, OWNER)).toBe(true);
    expect(statements.map((text) => text.split(' ').slice(0, 3).join(' '))).toEqual(['BEGIN', 'SELECT 1 FROM', 'DELETE FROM assistant_threads', 'UPDATE assistant_run_calls SET', 'DELETE FROM assistant_thread_clears', 'INSERT INTO assistant_thread_person_epochs', 'COMMIT']);
    expect(statements[3]).toContain("values_text = ''");
    expect(statements[3]).toContain('reply_text = NULL');
    expect(statements[3]).toContain('actor_id = $2 AND investigation_id = $1');
    expect(statements[3]).not.toMatch(/instructions_text|DELETE/);
    expect(statements[1]).toContain('FOR NO KEY UPDATE');
    expect(statements[5]).toContain('ON CONFLICT (investigation_id, user_id) DO UPDATE SET epoch = assistant_thread_person_epochs.epoch + 1');
    for (const index of [2, 3, 4, 5]) expect(parameters[index]).toEqual([INVESTIGATION, OWNER]);
    expect(parameters[1]).toEqual([INVESTIGATION]);
    expect(released.count).toBe(1);
  });

  it('says no thread was deleted, and still blanks the call text, for a person with no thread row', async () => {
    const { held, statements } = pool({ deleted: 0 });
    const store = createPgAssistantThreadStore(CONTEXT, { createPool: () => held });
    expect(await store.clearOwn(INVESTIGATION, OWNER)).toBe(false);
    expect(statements.some((text) => /^UPDATE assistant_run_calls/.test(text))).toBe(true);
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it.each([/^UPDATE assistant_run_calls/, /^DELETE FROM assistant_thread_clears/, /^DELETE FROM assistant_threads/, /^INSERT INTO assistant_thread_person_epochs/])('rolls the whole clearing back and answers the fixed error, with no driver text, when %s fails', async (failAt) => {
    const { held, statements, released } = pool({ failAt });
    const store = createPgAssistantThreadStore(CONTEXT, { createPool: () => held });
    const error = await store.clearOwn(INVESTIGATION, OWNER).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(AssistantThreadStoreError);
    expect(JSON.stringify([(error as Error).message])).not.toMatch(/DRIVER-TEXT|canary-secret-7f3/);
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(released.count).toBe(1);
  });

  it('says the outcome is not known, with no driver text, when the COMMIT fails or is cut off, and still rolls back and releases the connection', async () => {
    const { held, statements, released } = pool({ failAt: /^COMMIT$/ });
    const store = createPgAssistantThreadStore(CONTEXT, { createPool: () => held });
    const error = await store.clearOwn(INVESTIGATION, OWNER).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(AssistantThreadOutcomeUnknownError);
    expect(error).toBeInstanceOf(AssistantThreadStoreError);
    expect(JSON.stringify([(error as Error).message])).not.toMatch(/DRIVER-TEXT|canary-secret-7f3/);
    expect(statements.slice(-2)).toEqual(['COMMIT', 'ROLLBACK']);
    expect(released.count).toBe(1);
  });

  it.each([/^UPDATE assistant_run_calls/, /^DELETE FROM assistant_threads/, /FOR NO KEY UPDATE/])('does not say the outcome is unknown when %s fails: nothing was committed', async (failAt) => {
    const { held } = pool({ failAt });
    const error = await createPgAssistantThreadStore(CONTEXT, { createPool: () => held }).clearOwn(INVESTIGATION, OWNER).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(AssistantThreadStoreError);
    expect(error).not.toBeInstanceOf(AssistantThreadOutcomeUnknownError);
  });

  it('does nothing and says false for an investigation that is not there', async () => {
    const { held, statements } = pool({ status: 'none' });
    expect(await createPgAssistantThreadStore(CONTEXT, { createPool: () => held }).clearOwn(INVESTIGATION, OWNER)).toBe(false);
    expect(statements).toEqual([expect.stringMatching(/^BEGIN/), expect.stringContaining('FOR NO KEY UPDATE'), 'ROLLBACK']);
  });

  it('answers the fixed error when no connection can be made', async () => {
    const store = createPgAssistantThreadStore(CONTEXT, { createPool: () => ({ connect: async () => { throw new Error('refused DRIVER-TEXT'); }, end: async () => undefined, on: () => undefined }) });
    await expect(store.clearOwn(INVESTIGATION, OWNER)).rejects.toBeInstanceOf(AssistantThreadStoreError);
  });
});

describe('the clearing of the caller’s own thread by the memory store', () => {
  it('deletes only the caller’s thread of the investigation, and the caller’s other investigation and another person’s thread stay', async () => {
    const store = createMemoryAssistantThreadStore();
    const elsewhere = '0192f000-0000-7000-8000-0000000000a2';
    await store.append(turn(), 0);
    await store.append(turn({ userId: OTHER }), 0);
    await store.append(turn({ investigationId: elsewhere }), 0);
    expect(await store.clearOwn(INVESTIGATION, OWNER)).toBe(true);
    expect((await store.read(INVESTIGATION, OWNER, 100)).turns).toHaveLength(0);
    expect((await store.read(INVESTIGATION, OTHER, 100)).turns).toHaveLength(1);
    expect((await store.read(elsewhere, OWNER, 100)).turns).toHaveLength(1);
    expect(await store.clearOwn(INVESTIGATION, OWNER)).toBe(false);
  });

  it('forgets the caller’s clearing notice and gives the run records the same call, and fails when told to', async () => {
    const seen: string[] = [];
    const store = createMemoryAssistantThreadStore({ now: () => new Date('2026-11-18T12:00:00Z'), blankRunText: (investigationId, userId) => void seen.push(`${investigationId}:${userId}`) });
    await store.append(turn(), 0);
    store.clear(INVESTIGATION);
    expect((await store.read(INVESTIGATION, OWNER, 100)).previousThreadClearedAt).not.toBeNull();
    await store.clearOwn(INVESTIGATION, OWNER);
    expect((await store.read(INVESTIGATION, OWNER, 100)).previousThreadClearedAt).toBeNull();
    expect(seen).toEqual([`${INVESTIGATION}:${OWNER}`]);
    await expect(createMemoryAssistantThreadStore({ failOn: 'clear' }).clearOwn(INVESTIGATION, OWNER)).rejects.toBeInstanceOf(AssistantThreadStoreError);
    await expect(createMemoryAssistantThreadStore({ failOn: 'commit' }).clearOwn(INVESTIGATION, OWNER)).rejects.toBeInstanceOf(AssistantThreadOutcomeUnknownError);
  });
});

describe('the listing of the caller’s own threads by the Postgres store', () => {
  const listed = [
    { id: 'thread-2', investigation_id: INVESTIGATION, last_turn_at: new Date('2026-11-18T12:00:00.123Z'), key: '2026-11-18T12:00:00.123456Z', turns: 3, question: 'the newest question' },
    { id: 'thread-1', investigation_id: OTHER, last_turn_at: '2026-11-17T09:00:00Z', key: '2026-11-17T09:00:00.000000Z', turns: 1, question: null },
  ];

  it('reads the threads of the caller in one statement, newest last turn first, after the position given, and maps the rows without a value the statement did not select', async () => {
    const { held, statements, parameters, released } = pool({ listed });
    const store = createPgAssistantThreadStore(CONTEXT, { createPool: () => held });
    const rows = await store.listOwn(OWNER, { key: '2026-11-19T00:00:00.000000Z', id: 'thread-9' }, 200);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('WHERE h.user_id = $1');
    expect(statements[0]).toContain('ORDER BY h.last_turn_at DESC, h.id DESC');
    expect(statements[0]).toContain('LIMIT $4');
    expect(parameters[0]).toEqual([OWNER, '2026-11-19T00:00:00.000000Z', 'thread-9', 200]);
    expect(rows).toEqual([
      { threadId: 'thread-2', investigationId: INVESTIGATION, lastTurnAt: '2026-11-18T12:00:00.123Z', key: '2026-11-18T12:00:00.123456Z', turns: 3, lastQuestion: 'the newest question' },
      { threadId: 'thread-1', investigationId: OTHER, lastTurnAt: '2026-11-17T09:00:00.000Z', key: '2026-11-17T09:00:00.000000Z', turns: 1, lastQuestion: null },
    ]);
    expect(released.count).toBe(1);
  });

  it('starts at the first page with no position, and answers the fixed error with no driver text when the statement fails', async () => {
    const first = pool({ listed: [] });
    expect(await createPgAssistantThreadStore(CONTEXT, { createPool: () => first.held }).listOwn(OWNER, undefined, 25)).toEqual([]);
    expect(first.parameters[0]).toEqual([OWNER, null, null, 25]);
    const failing = pool({ failAt: /^SELECT h\.id/ });
    const error = await createPgAssistantThreadStore(CONTEXT, { createPool: () => failing.held }).listOwn(OWNER, undefined, 25).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(AssistantThreadStoreError);
    expect(JSON.stringify([(error as Error).message])).not.toMatch(/DRIVER-TEXT|canary-secret-7f3/);
    expect(failing.released.count).toBe(1);
  });

  it('lists nothing and fails as the fixed error from the memory store when it is made to fail', async () => {
    await expect(createMemoryAssistantThreadStore({ failOn: 'read' }).listOwn(OWNER, undefined, 5)).rejects.toBeInstanceOf(AssistantThreadStoreError);
  });
});
