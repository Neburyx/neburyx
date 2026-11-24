import { describe, expect, it } from 'vitest';
import { ASK_FOLDER_LIMITS } from './ask-folder.js';
import { ASK_SUMMARY_MAX_CITATIONS } from './ask.js';
import { ASSISTANT_VIEW_KEYS_MAX, assistantTurnRequestSchema } from './assistant-turn.js';
import { CHAT_LAST_QUESTION_MAX, CHAT_LIST_DEFAULT_LIMIT, CHAT_LIST_MAX_LIMIT, CHAT_LIST_SCAN_CAP, THREAD_READ_TURNS_CEILING, assistantThreadListQuerySchema, assistantThreadListResponseSchema, assistantThreadClearRequestSchema, assistantThreadClearResponseSchema, assistantThreadResponseSchema, assistantThreadTurnWriteSchema, readAnswerSchema, threadEntitySchema, type AssistantThreadTurnWrite } from './assistant-thread.js';

const HASH = 'a'.repeat(64);
const REF = { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' };
const EDGE = { sourceId: 'demo', type: 'LINKS', from: 'widget', to: 'widget', stableId: 'L-1' };
const turn = (over: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), investigationId: crypto.randomUUID(), userId: crypto.randomUUID(), at: new Date(), route: 'ask', outcome: 'answered', questionHash: HASH, entities: [], citationRefs: [], steps: 0, ...over });
const accepts = (value: unknown): boolean => assistantThreadTurnWriteSchema.safeParse(value).success;

describe('what a turn leaves in its thread', () => {
  it('takes references and metadata: an element each parameter resolved to, element and relationship citations, a long identifier, and a turn with no model call', () => {
    expect(accepts(turn({ entities: [{ role: 'id', ref: REF }], citationRefs: [REF, EDGE], intent: 'widgetById', modelRef: 'm', promptVersion: '1', tokensIn: 3 }))).toBe(true);
    expect(accepts(turn({ citationRefs: [{ ...REF, stableId: 'W-'.padEnd(500, '9') }] }))).toBe(true);
    const bare: AssistantThreadTurnWrite = assistantThreadTurnWriteSchema.parse(turn());
    expect(bare).not.toHaveProperty('modelRef');
    expect(bare).not.toHaveProperty('tokensIn');
  });

  it.each([
    ['a free member in an entity', { entities: [{ role: 'id', ref: REF, text: 'Ana Silva' }] }],
    ['a free member in a reference', { citationRefs: [{ ...REF, title: 'Ana Silva' }] }],
    ['a role that is not a parameter name', { entities: [{ role: 'not a name!', ref: REF }] }],
    ['a member the turn does not have', { message: 'Show Ana Silva' }],
    ['a plain digest that is not hex', { questionHash: 'Ana Silva' }],
    ['a fractional or negative count', { steps: 1.5 }],
    ['a route that is not kept', { route: 'plan' }],
    ['an end that is not kept', { outcome: 'failed' }],
    ['a cause that is a sentence', { cause: 'a sentence with spaces' }],
    ['more entities than an intent has parameters', { entities: Array.from({ length: ASK_FOLDER_LIMITS.parameters + 1 }, () => ({ role: 'id', ref: REF })) }],
    ['more citations than an Ask summary holds', { citationRefs: Array.from({ length: ASK_SUMMARY_MAX_CITATIONS + 1 }, () => REF) }],
  ])('refuses %s', (_name, over) => {
    expect(accepts(turn(over))).toBe(false);
  });

  it('allows a view answer as many citations as the view has keys, and no more', () => {
    expect(accepts(turn({ route: 'view', citationRefs: Array.from({ length: ASSISTANT_VIEW_KEYS_MAX }, () => REF) }))).toBe(true);
    expect(accepts(turn({ route: 'view', citationRefs: Array.from({ length: ASSISTANT_VIEW_KEYS_MAX + 1 }, () => REF) }))).toBe(false);
  });

  it('has a strict entity schema', () => {
    expect(threadEntitySchema.safeParse({ role: 'id', ref: REF }).success).toBe(true);
    expect(threadEntitySchema.safeParse({ role: 'id' }).success).toBe(false);
  });
});

describe('what the panel is told of a thread', () => {
  const stored = { id: '0192f000-0000-7000-8000-0000000000bb', seq: 1, at: '2026-11-18T10:00:00.000Z', route: 'ask', outcome: 'answered', intent: 'widgetById', citedElements: 2, steps: 1 };

  it('holds the kind and end of each turn and when the previous thread was cleared, and nothing else', () => {
    expect(assistantThreadResponseSchema.safeParse({ turns: [stored], earlierTurns: 0, previousThreadClearedAt: null }).success).toBe(true);
    expect(assistantThreadResponseSchema.safeParse({ turns: [], earlierTurns: 4, previousThreadClearedAt: '2026-11-18T12:00:00.000Z' }).success).toBe(true);
    for (const extra of [{ questionHash: HASH }, { citationRefs: [REF] }, { runId: crypto.randomUUID() }, { tokensIn: 1 }]) expect(assistantThreadResponseSchema.safeParse({ turns: [{ ...stored, ...extra }], earlierTurns: 0, previousThreadClearedAt: null }).success).toBe(false);
    expect(assistantThreadResponseSchema.safeParse({ turns: [], earlierTurns: 0, previousThreadClearedAt: null, note: 'x' }).success).toBe(false);
    expect(assistantThreadResponseSchema.safeParse({ turns: [stored] }).success).toBe(false);
    expect(assistantThreadResponseSchema.safeParse({ turns: Array.from({ length: THREAD_READ_TURNS_CEILING + 1 }, (_unused, index) => ({ ...stored, seq: index + 1 })), earlierTurns: 0, previousThreadClearedAt: null }).success).toBe(false);
  });
});

describe('the stored form of an answer', () => {
  const written = (answer: unknown) => assistantThreadTurnWriteSchema.safeParse(turn({ route: 'view', question: 'Q?', maskOn: true, answer })).success;
  const sentence = { form: 'frozen', text: 'One.', cites: [REF] };

  it('still takes an answer of sentences, a table and a refusal that holds no list, with or without the model and the coverage', () => {
    expect(written({ blocks: [{ kind: 'sentences', items: [sentence] }] })).toBe(true);
    expect(written({ model: 'm', coverage: { retrieval: 'r', summary: 's' }, blocks: [{ kind: 'sentences', items: [sentence] }] })).toBe(true);
    expect(written({ blocks: [{ kind: 'refusal', sentence: { form: 'frozen', text: 'No.' } }] })).toBe(true);
  });

  it('takes a list with an optional label and items that are cited as sentences, and refuses a list with no item, one item too many, a free member or a label longer than its bound', () => {
    expect(written({ blocks: [{ kind: 'list', items: [sentence] }] })).toBe(true);
    expect(written({ blocks: [{ kind: 'list', label: { form: 'frozen', text: 'Label' }, items: [sentence] }] })).toBe(true);
    expect(written({ blocks: [{ kind: 'list', items: [] }] })).toBe(false);
    expect(written({ blocks: [{ kind: 'list', items: Array.from({ length: 13 }, () => sentence) }] })).toBe(false);
    expect(written({ blocks: [{ kind: 'list', items: [sentence], extra: 'x' }] })).toBe(false);
    expect(written({ blocks: [{ kind: 'list', label: { form: 'frozen', text: 'x'.repeat(200) }, items: [sentence] }] })).toBe(false);
  });

  it('refuses a free member beside the model and the coverage', () => {
    expect(written({ model: 'm', coverage: { retrieval: 'r', summary: 's', text: 'x' }, blocks: [{ kind: 'sentences', items: [sentence] }] })).toBe(false);
  });
});

describe('the id of a turn', () => {
  const ID = '0192f000-0000-7000-8000-0000000000aa';
  const row = { seq: 1, at: '2026-11-18T10:00:00.000Z', route: 'view', outcome: 'answered', citedElements: 0, steps: 0 };

  it('is told to the panel for every turn, as a uuid, and a turn without one is refused', () => {
    expect(assistantThreadResponseSchema.safeParse({ turns: [{ id: ID, ...row }], earlierTurns: 0, previousThreadClearedAt: null }).success).toBe(true);
    expect(assistantThreadResponseSchema.safeParse({ turns: [row], earlierTurns: 0, previousThreadClearedAt: null }).success).toBe(false);
    expect(assistantThreadResponseSchema.safeParse({ turns: [{ id: 'not-a-uuid', ...row }], earlierTurns: 0, previousThreadClearedAt: null }).success).toBe(false);
  });

  it('may be given by a request of each kind, as a uuid only', () => {
    const base = { sourceId: 's', investigationId: 'i', viewElementKeys: [] };
    expect(assistantTurnRequestSchema.safeParse({ ...base, message: 'hello', turnId: ID }).success).toBe(true);
    expect(assistantTurnRequestSchema.safeParse({ ...base, message: 'hello' }).success).toBe(true);
    expect(assistantTurnRequestSchema.safeParse({ ...base, message: 'hello', turnId: 'x' }).success).toBe(false);
    expect(assistantTurnRequestSchema.safeParse({ ...base, message: 'hello', turnId: 5 }).success).toBe(false);
  });
});

describe('the clearing of a thread', () => {
  it('takes the empty object and nothing else, and answers one boolean', () => {
    expect(assistantThreadClearRequestSchema.safeParse({}).success).toBe(true);
    for (const body of [undefined, null, [], 'x', 1, { cleared: true }, { text: 'a question' }]) expect(assistantThreadClearRequestSchema.safeParse(body).success).toBe(false);
    expect(assistantThreadClearResponseSchema.parse({ cleared: false })).toEqual({ cleared: false });
    for (const body of [{}, { cleared: 'yes' }, { cleared: true, turns: 3 }, { cleared: true, runId: 'x' }]) expect(assistantThreadClearResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe('the count a thread read tells', () => {
  const base = { turns: [], earlierTurns: 0, previousThreadClearedAt: null };

  it('is a whole number that may be absent, and nothing else', () => {
    expect(assistantThreadResponseSchema.safeParse(base).success).toBe(true);
    expect(assistantThreadResponseSchema.safeParse({ ...base, epoch: 0 }).success).toBe(true);
    expect(assistantThreadResponseSchema.safeParse({ ...base, epoch: 7 }).success).toBe(true);
    for (const epoch of [-1, 1.5, '2', null]) expect(assistantThreadResponseSchema.safeParse({ ...base, epoch }).success).toBe(false);
  });

  describe('the caption, the units and the counts of a stored table', () => {
    const row = { cells: [{ form: 'frozen', text: 'Ana' }], cites: [REF] };
    const block = (over: Record<string, unknown> = {}) => ({ kind: 'table', columns: [{ form: 'frozen', text: 'Name' }], rows: [row], ...over });
    const writtenTable = (over: Record<string, unknown>) => assistantThreadTurnWriteSchema.safeParse(turn({ route: 'view', question: 'Q?', maskOn: true, answer: { blocks: [block(over)] } })).success;

    it('takes the type of the rows, the anchor as an item, the properties of the units and the counts, all optional', () => {
      expect(writtenTable({})).toBe(true);
      expect(writtenTable({ caption: {} })).toBe(true);
      expect(writtenTable({ caption: { subject: 'widget', anchor: { form: 'unbound', text: 'Ana Silva' } }, units: [{ type: 'widget', property: 'sizeUsd' }], droppedRows: 1, moreNotShown: 4 })).toBe(true);
    });

    it.each([
      ['an anchor that is a bare string', { caption: { anchor: 'Ana Silva' } }],
      ['a binding as the anchor with no segments', { caption: { anchor: { form: 'bound' } } }],
      ['a free member in the caption', { caption: { subject: 'widget', title: 'Widgets of Ana Silva' } }],
      ['a title kept as text', { title: 'Widgets of Ana Silva · 1 row' }],
      ['a note kept as text', { note: 'Size in USD.' }],
      ['a free member in a unit', { units: [{ type: 'widget', property: 'sizeUsd', label: 'Size' }] }],
      ['an empty type key', { caption: { subject: '' } }],
      ['a count that is not a positive whole number', { droppedRows: 0 }],
      ['a fractional count', { moreNotShown: 1.5 }],
    ])('refuses %s', (_name, over) => {
      expect(writtenTable(over)).toBe(false);
    });

    it('is sent as the read form: the anchor as text or withheld, nothing as a binding', () => {
      const answer = { blocks: [{ kind: 'table', caption: { subject: 'widget', anchor: { state: 'withheld' } }, units: [{ type: 'widget', property: 'sizeUsd' }], droppedRows: 1, moreNotShown: 2, columns: [{ state: 'text', text: 'Name' }], rows: [{ cells: [{ state: 'withheld' }], cites: [REF] }] }] };
      expect(readAnswerSchema.safeParse(answer).success).toBe(true);
      expect(readAnswerSchema.safeParse({ blocks: [{ ...answer.blocks[0], caption: { anchor: { state: 'text', text: 'Ana', extra: 1 } } }] }).success).toBe(false);
      expect(readAnswerSchema.safeParse({ blocks: [{ ...answer.blocks[0], title: 'Widgets' }] }).success).toBe(false);
      expect(readAnswerSchema.safeParse({ blocks: [{ ...answer.blocks[0], caption: { anchor: { state: 'segments', segments: [{ element: REF, property: 'name' }] } } }] }).success).toBe(false);
    });
  });
});

describe('the list of chats', () => {
  const item = { investigationId: '0192f000-0000-7000-8000-000000000001', title: 'A title', caseRef: null, sourceId: 'demo', sourceAlias: 'demo', sourceState: 'available', lastQuestionAt: '2026-11-18T10:00:00.000Z', turns: 2, lastQuestion: 'A question' };

  it('accepts a page with a last question of at most 200 code points, whatever their size in UTF-16 units, or none, and a cursor or none', () => {
    expect(assistantThreadListResponseSchema.safeParse({ items: [item, { ...item, lastQuestion: '😀'.repeat(200) }, { ...item, lastQuestion: null }], nextCursor: 'abc.def' }).success).toBe(true);
    expect(assistantThreadListResponseSchema.safeParse({ items: [], nextCursor: null }).success).toBe(true);
  });

  it('refuses a last question of 201 code points, an extra member, a missing member, a negative count, a source state that is not one and more than 100 items', () => {
    for (const bad of [{ ...item, lastQuestion: 'x'.repeat(201) }, { ...item, extra: 1 }, { ...item, turns: -1 }, { ...item, sourceState: 'gone' }, { ...item, lastQuestionAt: 'yesterday' }]) expect(assistantThreadListResponseSchema.safeParse({ items: [bad], nextCursor: null }).success).toBe(false);
    const { title: _title, ...missing } = item;
    expect(assistantThreadListResponseSchema.safeParse({ items: [missing], nextCursor: null }).success).toBe(false);
    expect(assistantThreadListResponseSchema.safeParse({ items: Array.from({ length: 101 }, () => item), nextCursor: null }).success).toBe(false);
    expect(assistantThreadListResponseSchema.safeParse({ items: [item], nextCursor: '' }).success).toBe(false);
  });

  it('reads the query as the investigations list does: a limit as digits, a cursor of at most 2048 characters and a search of 2 to 200 characters with no NUL', () => {
    expect(assistantThreadListQuerySchema.parse({ limit: '25', q: 'beta', cursor: 'abc' })).toEqual({ limit: 25, q: 'beta', cursor: 'abc' });
    for (const bad of [{ limit: '-1' }, { limit: '1.5' }, { limit: 'x' }, { cursor: '' }, { cursor: 'c'.repeat(2049) }, { q: 'a' }, { q: 'x'.repeat(201) }, { q: 'a\u0000b' }, { extra: '1' }]) expect(assistantThreadListQuerySchema.safeParse(bad).success).toBe(false);
    expect([CHAT_LIST_DEFAULT_LIMIT, CHAT_LIST_MAX_LIMIT, CHAT_LIST_SCAN_CAP, CHAT_LAST_QUESTION_MAX]).toEqual([25, 100, 1000, 200]);
  });
});
