import type { AssistantTurnAnswer } from '@neburyx/contracts';
import { assistantThreadTurnWriteSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { bindingsApproved, storedAnswerOf } from './thread-answer.js';
import { classifyItem, type ClassifyContext } from './sensitive-items.js';

const REF = { sourceId: 'demo', entityType: 'widget', stableId: 'A-1' };
const citation = { key: 'n1', kind: 'entity', ref: REF } as const;
const base = { id: crypto.randomUUID(), investigationId: crypto.randomUUID(), userId: crypto.randomUUID(), at: new Date(), route: 'view', outcome: 'answered', questionHash: 'a'.repeat(64), entities: [], citationRefs: [], steps: 0, maskOn: false } as const;
/** An answer of the view route in the blocks form: `sentences` and `table` of `over` become the blocks, the rest stays as it is. */
const viewAnswer = (over: Record<string, unknown>): AssistantTurnAnswer => {
  const { sentences, table, ...rest } = over;
  const blocks = [...(table === undefined ? [] : [{ kind: 'table', table: { note: 'n', ...(table as object) } }]), ...(sentences === undefined ? [] : [{ kind: 'sentences', sentences }])];
  return { status: 'answered', route: 'view', citations: [citation], coverage: { retrieval: 'x', summary: 'y' }, model: 'm', calls: 1, blocks, ...rest } as AssistantTurnAnswer;
};
const written = (answer: AssistantTurnAnswer, maskOn: boolean) => assistantThreadTurnWriteSchema.parse({ ...base, maskOn, question: 'Q?', answer: storedAnswerOf(answer, maskOn)?.answer });

describe('the stored form of an answer', () => {
  it('keeps a table with an empty cell, each column and each cell in the form of the mask state, and the fixed server lines in a block of their own', () => {
    const answer = viewAnswer({ table: { title: 'T', columns: ['Name', 'Note'], rows: [{ cells: ['Ana', ''], cites: ['n1'] }] }, pointer: 'A fixed pointer sentence.', noDescription: 'A fixed description sentence.', lastCallNote: 'A fixed note.' });
    for (const [maskOn, form] of [[false, 'unbound'], [true, 'frozen']] as const) {
      const stored = written(answer, maskOn).answer;
      expect(stored?.blocks[0]).toEqual({ kind: 'table', columns: [{ form, text: 'Name' }, { form, text: 'Note' }], rows: [{ cells: [{ form, text: 'Ana' }, { form, text: '' }], cites: [REF] }] });
      expect(stored?.blocks[1]).toEqual({ kind: 'sentences', items: [{ form: 'frozen', text: 'A fixed description sentence.', cites: [] }, { form: 'frozen', text: 'A fixed pointer sentence.', cites: [] }, { form: 'frozen', text: 'A fixed note.', cites: [] }] });
    }
  });

  it('keeps the blocks of an answer in the order the model gave them, each in its own stored block, with the fixed lines last', () => {
    const answer = {
      status: 'answered', route: 'view', citations: [citation], coverage: { retrieval: 'x', summary: 'y' }, model: 'm', calls: 1, pointer: 'A fixed pointer sentence.',
      blocks: [{ kind: 'sentences', sentences: [{ text: 'First.', cites: ['n1'] }] }, { kind: 'table', table: { title: 'T', columns: ['Name'], rows: [{ cells: ['Ana'], cites: ['n1'] }], note: 'n' } }, { kind: 'sentences', sentences: [{ text: 'Last.', cites: ['n1'] }] }],
    } as AssistantTurnAnswer;
    const stored = written(answer, true).answer;
    expect(stored?.blocks.map((block) => block.kind)).toEqual(['sentences', 'table', 'sentences', 'sentences']);
    expect(stored?.blocks[0]).toMatchObject({ items: [{ text: 'First.' }] });
    expect(stored?.blocks[2]).toMatchObject({ items: [{ text: 'Last.' }] });
    expect(stored?.blocks[3]).toMatchObject({ items: [{ text: 'A fixed pointer sentence.' }] });
  });

  it('keeps twelve sentences of the model and the three fixed lines, cutting nothing', () => {
    const sentences = Array.from({ length: 12 }, (_, index) => ({ text: `Sentence ${index + 1}.`, cites: ['n1'] }));
    const stored = written(viewAnswer({ sentences, pointer: 'P.', noDescription: 'N.', lastCallNote: 'L.' }), false).answer;
    expect(stored?.blocks.flatMap((block) => (block.kind === 'sentences' ? block.items : []))).toHaveLength(15);
  });

  it('keeps a value as the answer shows it: written with the mask on, the masked text is stored frozen, and nothing else of the element', () => {
    const stored = written(viewAnswer({ sentences: [{ text: 'The holder is ******* here.', cites: ['n1'] }] }), true);
    expect(JSON.stringify(stored.answer)).not.toContain('Ana Silva');
    expect(stored.answer?.blocks[0]).toMatchObject({ kind: 'sentences', items: [{ form: 'frozen', text: 'The holder is ******* here.' }] });
  });

  it('keeps the fixed sentences of a refusal frozen when the mask is off, and gives no form to an answer that has none yet', () => {
    const refusal = { status: 'answered', route: 'refuse', cause: 'verdict', sentence: 'A fixed refusal.' } as AssistantTurnAnswer;
    expect(storedAnswerOf(refusal, false)?.answer.blocks[0]).toEqual({ kind: 'refusal', sentence: { form: 'frozen', text: 'A fixed refusal.' } });
    expect(storedAnswerOf({ status: 'cancelled' } as AssistantTurnAnswer, false)).toBeUndefined();
  });

  describe('the binding forms', () => {
    const sentValues = new Map([['n1', [{ key: 'holder', text: 'Jordan Lee', masked: false }, { key: 'plain', text: 'gold', masked: false }]]]);
    const context: ClassifyContext = { sentValues, sent: ['n1'], typeOf: () => 'widget', sensitiveKeys: new Map([['widget', ['holder']]]) };
    const classify = (text: string, cited: readonly string[]) => classifyItem(text, cited, context);
    const sentence = (text: string) => storedAnswerOf(viewAnswer({ sentences: [{ text, cites: ['n1'] }] }), false, classify);
    const first = (result: ReturnType<typeof storedAnswerOf>) => (result?.answer.blocks[0]?.kind === 'sentences' ? result.answer.blocks[0].items[0] : undefined);

    it('stores segments with the element and the property and no value, for each value of an item, and keeps the text of a bound item reconstructible', () => {
      const item = first(sentence('Jordan Lee met Jordan Lee.'));
      expect(item).toMatchObject({ form: 'bound', segments: [{ element: REF, property: 'holder' }, { literal: ' met ' }, { element: REF, property: 'holder' }, { literal: '.' }] });
      expect(JSON.stringify(item)).not.toContain('Jordan');
    });

    it('stores an item that needs more than 40 segments unbound, as written, and a text over its bound as written so that the schema refuses it', () => {
      const many = Array.from({ length: 21 }, () => 'Jordan Lee').join(' and ');
      expect(first(sentence(many))).toMatchObject({ form: 'unbound', text: many });
      const long = `Jordan Lee ${'x'.repeat(2000)}`;
      expect(first(sentence(long))).toMatchObject({ form: 'unbound', text: long });
      expect(() => written(viewAnswer({ sentences: [{ text: long, cites: ['n1'] }] }), false)).toThrow();
    });

    it('refuses a binding to an element that was not sent, a property that is not one of its values, a property that is not sensitive, or no provenance', () => {
      const stored = sentence('Jordan Lee is listed.');
      if (stored === undefined) throw new Error('no stored form');
      const keyOf = (ref: unknown) => (JSON.stringify(ref) === JSON.stringify(REF) ? 'n1' : undefined);
      expect(bindingsApproved(stored.answer, context, stored.keyOf, 'demo')).toBe(true);
      expect(bindingsApproved(stored.answer, context, () => undefined, 'demo')).toBe(false);
      expect(bindingsApproved(stored.answer, context, () => 'n9', 'demo')).toBe(false);
      expect(bindingsApproved(stored.answer, { ...context, sensitiveKeys: new Map([['widget', ['other']]]) }, keyOf, 'demo')).toBe(false);
      expect(bindingsApproved(stored.answer, { ...context, sentValues: new Map([['n1', [{ key: 'plain', text: 'gold', masked: false }]]]) }, keyOf, 'demo')).toBe(false);
      expect(bindingsApproved(stored.answer, { ...context, sentValues: undefined }, keyOf, 'demo')).toBe(false);
    });

    it('refuses in the schema a binding to an element the item does not cite, and a bound item with no binding', () => {
      const bound = { form: 'bound', segments: [{ element: REF, property: 'holder' }], cites: [] };
      expect(assistantThreadTurnWriteSchema.safeParse({ ...base, question: 'Q?', answer: { blocks: [{ kind: 'sentences', items: [bound] }] } }).success).toBe(false);
      expect(assistantThreadTurnWriteSchema.safeParse({ ...base, question: 'Q?', answer: { blocks: [{ kind: 'sentences', items: [{ form: 'bound', segments: [{ literal: 'x' }], cites: [REF] }] }] } }).success).toBe(false);
      expect(assistantThreadTurnWriteSchema.safeParse({ ...base, question: 'Q?', answer: { blocks: [{ kind: 'sentences', items: [{ ...bound, cites: [REF] }] }] } }).success).toBe(true);
    });
    it('refuses a binding to another sensitive property the element holds, to an element of another source, and to an element the item does not cite', () => {
      const two = { ...context, sentValues: new Map([['n1', [{ key: 'holder', text: 'Jordan Lee', masked: false }, { key: 'partner', text: 'Maria Gomez', masked: false }]]]), sensitiveKeys: new Map([['widget', ['holder', 'partner']]]) };
      const stored = storedAnswerOf(viewAnswer({ sentences: [{ text: 'Jordan Lee is listed.', cites: ['n1'] }] }), false, (text, cited) => classifyItem(text, cited, two));
      if (stored === undefined) throw new Error('no stored form');
      const keyOf = stored.keyOf;
      expect(bindingsApproved(stored.answer, two, keyOf, 'demo')).toBe(true);
      const item = stored.answer.blocks[0]?.kind === 'sentences' ? stored.answer.blocks[0].items[0] : undefined;
      const swapped = JSON.parse(JSON.stringify(stored.answer).replace('"property":"holder"', '"property":"partner"')) as typeof stored.answer;
      expect(item?.form).toBe('bound');
      expect(bindingsApproved(swapped, two, keyOf, 'demo')).toBe(false);
      expect(bindingsApproved(stored.answer, two, keyOf, 'another-source')).toBe(false);
    });

    it('binds each whole value of a table cell, leaves a cell with a shared value or a partial one unbound, and keeps exactly 40 segments bound and 41 unbound', () => {
      const values = new Map([['n1', [{ key: 'holder', text: 'Jordan Lee', masked: false }]], ['n2', [{ key: 'holder', text: 'Maria Gomez', masked: false }]], ['n3', [{ key: 'holder', text: 'Maria Gomez', masked: false }]]]);
      const wide: ClassifyContext = { sentValues: values, sent: ['n1', 'n2', 'n3'], typeOf: () => 'widget', sensitiveKeys: new Map([['widget', ['holder']]]) };
      const cites = ['n1', 'n2', 'n3'];
      const refOf = (id: string) => ({ ...REF, stableId: id });
      const citations = ['n1', 'n2', 'n3'].map((key, index) => ({ key, kind: 'entity', ref: refOf(`A-${index + 1}`) }));
      const table = (cell: string) => storedAnswerOf({ status: 'answered', route: 'view', citations, coverage: { retrieval: 'x', summary: 'y' }, model: 'm', calls: 1, blocks: [{ kind: 'table', table: { title: 'T', columns: ['C'], rows: [{ cells: [cell], cites }], note: 'n' } }] } as AssistantTurnAnswer, false, (text, cited) => classifyItem(text, cited, wide));
      const cell = (result: ReturnType<typeof table>) => (result?.answer.blocks[0]?.kind === 'table' ? result.answer.blocks[0].rows[0]?.cells[0] : undefined);
      expect(cell(table('Jordan Lee'))).toMatchObject({ form: 'bound' });
      expect(cell(table('Maria Gomez'))).toMatchObject({ form: 'unbound', text: 'Maria Gomez' });
      expect(cell(table('Jordan'))).toMatchObject({ form: 'unbound' });
      const exact = (count: number) => Array.from({ length: count }, () => 'Jordan Lee').join('/');
      // 20 values and 19 separators are 39 segments; 20 values with 20 pieces of text around them are 40; one more is 41
      const sentenceAt = (text: string) => storedAnswerOf(viewAnswer({ sentences: [{ text, cites: ['n1'] }] }), false, (value, citedKeys) => classifyItem(value, citedKeys, wide));
      const items = (result: ReturnType<typeof sentenceAt>) => (result?.answer.blocks[0]?.kind === 'sentences' ? result.answer.blocks[0].items[0] : undefined);
      const forty = `${Array.from({ length: 20 }, () => 'Jordan Lee x').join(' ')}`;
      expect(items(sentenceAt(forty))).toMatchObject({ form: 'bound' });
      expect((items(sentenceAt(forty)) as { segments: unknown[] }).segments).toHaveLength(40);
      expect(items(sentenceAt(`${forty} Jordan Lee`))).toMatchObject({ form: 'unbound' });
      expect(exact(2)).toBe('Jordan Lee/Jordan Lee');
    });
  });
});

