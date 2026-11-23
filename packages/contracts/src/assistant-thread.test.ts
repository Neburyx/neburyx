import { describe, expect, it } from 'vitest';
import { ASK_FOLDER_LIMITS } from './ask-folder.js';
import { ASK_SUMMARY_MAX_CITATIONS } from './ask.js';
import { ASSISTANT_VIEW_KEYS_MAX, assistantTurnRequestSchema } from './assistant-turn.js';
import { THREAD_READ_TURNS_CEILING, assistantThreadResponseSchema, assistantThreadTurnWriteSchema, threadEntitySchema, type AssistantThreadTurnWrite } from './assistant-thread.js';

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
