import type { AskRunResult, AssistantTurnAnswer } from '@neburyx/contracts';
import { buildSummary } from '../summary/index.js';
import { presentThread } from './thread-present.js';
import { assistantThreadTurnWriteSchema } from '@neburyx/contracts';
import { describe, expect, it, vi } from 'vitest';
import { bindingsApproved, storedAnswerOf } from './thread-answer.js';
import { classifyItem, type ClassifyContext } from './sensitive-items.js';

vi.mock('../summary/index.js', async (original) => {
  const module = await original<typeof import('../summary/index.js')>();
  return { ...module, buildSummary: vi.fn(module.buildSummary) };
});

const REF = { sourceId: 'demo', entityType: 'widget', stableId: 'A-1' };
const citation = { key: 'n1', kind: 'entity', ref: REF } as const;
const base = { id: crypto.randomUUID(), investigationId: crypto.randomUUID(), userId: crypto.randomUUID(), at: new Date(), route: 'view', outcome: 'answered', questionHash: 'a'.repeat(64), entities: [], citationRefs: [], steps: 0, maskOn: false } as const;
/** An answer of the view route in the blocks form: `sentences` and `table` of `over` become the blocks, the rest stays as it is. */
const viewAnswer = (over: Record<string, unknown>): AssistantTurnAnswer => {
  const { sentences, table, blocks: given, ...rest } = over;
  const blocks = (given as unknown[] | undefined) ?? [...(table === undefined ? [] : [{ kind: 'table', table: { note: 'n', ...(table as object) } }]), ...(sentences === undefined ? [] : [{ kind: 'sentences', sentences }])];
  return { status: 'answered', route: 'view', citations: [citation], coverage: { retrieval: 'x', summary: 'y' }, model: 'm', calls: 1, blocks, ...rest } as AssistantTurnAnswer;
};
const written = (answer: AssistantTurnAnswer, maskOn: boolean) => assistantThreadTurnWriteSchema.parse({ ...base, maskOn, question: 'Q?', answer: storedAnswerOf(answer, maskOn)?.answer });

describe('the stored form of an answer', () => {
  it('keeps a table with an empty cell, each column and each cell in the form of the mask state, and the fixed server lines in a block of their own', () => {
    const answer = viewAnswer({ table: { title: 'T', columns: ['Name', 'Note'], rows: [{ cells: ['Ana', ''], cites: ['n1'] }] }, pointer: 'A fixed pointer sentence.', noDescription: 'A fixed description sentence.', lastCallNote: 'A fixed note.' });
    for (const [maskOn, form] of [[false, 'unbound'], [true, 'frozen']] as const) {
      const stored = written(answer, maskOn).answer;
      expect(stored?.blocks[0]).toEqual({ kind: 'table', caption: {}, columns: [{ form, text: 'Name' }, { form, text: 'Note' }], rows: [{ cells: [{ form, text: 'Ana' }, { form, text: '' }], cites: [REF] }] });
      expect(stored?.blocks[1]).toEqual({ kind: 'sentences', items: [{ form: 'frozen', text: 'A fixed description sentence.', cites: [] }, { form: 'frozen', text: 'A fixed pointer sentence.', cites: [] }, { form: 'frozen', text: 'A fixed note.', cites: [] }] });
    }
  });

  it('keeps the caption and the note of a table as references and numbers: the type, the anchor as an item, the properties of the units, the rows dropped and not shown', () => {
    const table = { title: 'Widgets of Jordan Lee · 1 row', subject: 'widget', anchor: 'Jordan Lee', units: [{ type: 'widget', property: 'sizeUsd' }], droppedRows: 2, moreNotShown: 5, columns: ['Name'], rows: [{ cells: ['Ana'], cites: ['n1'] }] };
    const answer = viewAnswer({ table });
    const masked = written(answer, true).answer?.blocks[0];
    expect(masked).toMatchObject({ kind: 'table', caption: { subject: 'widget', anchor: { form: 'frozen', text: 'Jordan Lee' } }, units: [{ type: 'widget', property: 'sizeUsd' }], droppedRows: 2, moreNotShown: 5 });
    // with the mask off the anchor is source text the model never wrote, so no classifier can vouch for it: it is stored whole and flagged, whatever the classifier says of other text, and never as a binding
    const open = written(answer, false).answer?.blocks[0];
    expect(open).toMatchObject({ caption: { anchor: { form: 'unbound', text: 'Jordan Lee' } } });
    const sure = storedAnswerOf(answer, false, () => ({ form: 'frozen', spans: [] }) as never)?.answer.blocks[0];
    expect(sure).toMatchObject({ caption: { anchor: { form: 'unbound', text: 'Jordan Lee' } } });
    // the title and the note are never stored as text
    expect(JSON.stringify(masked)).not.toContain('Widgets of');
    // a table with no fact of this kind keeps an empty caption and no units
    const plain = written(viewAnswer({ table: { title: 'T', columns: ['Name'], rows: [{ cells: ['Ana'], cites: ['n1'] }] } }), true).answer?.blocks[0];
    expect(plain).toMatchObject({ caption: {} });
    expect(plain).not.toHaveProperty('units');
    expect(plain).not.toHaveProperty('droppedRows');
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

  it('keeps the model and the lines of coverage of an answer with its blocks, the line of a cited summary when there is one, and none for an answer that has neither', () => {
    const coverage = { retrieval: '27 shown · ≥ 184,506 not yet retrieved (lower bound)', summary: 'The answer cites 1 of the 27 elements the reads returned.' };
    const stored = written(viewAnswer({ sentences: [{ text: 'First.', cites: ['n1'] }], model: 'fixture-model', coverage: { ...coverage, summaryCited: 'It rests on sentence 2 of the summary.' } }), false).answer;
    expect(stored).toMatchObject({ model: 'fixture-model', coverage: { ...coverage, summaryCited: 'It rests on sentence 2 of the summary.' } });
    const plain = written(viewAnswer({ sentences: [{ text: 'First.', cites: ['n1'] }], model: 'fixture-model', coverage }), false).answer;
    expect(plain?.coverage).toEqual(coverage);
    const refusal = storedAnswerOf({ status: 'not-answered', route: 'view', sentence: 'A fixed sentence.' } as AssistantTurnAnswer, false)?.answer;
    expect(refusal).not.toHaveProperty('model');
    expect(refusal).not.toHaveProperty('coverage');
  });

  it('stores a list block with its label and its items as it stores sentences: frozen under the mask, classified with it off, with the cites of each item', () => {
    const list = viewAnswer({ blocks: [{ kind: 'list', label: 'The holders', items: [{ text: 'First item.', cites: ['n1'] }, { text: 'Second item.', cites: ['n1'] }] }] });
    for (const [maskOn, form] of [[true, 'frozen'], [false, 'unbound']] as const) {
      const stored = written(list, maskOn).answer;
      expect(stored?.blocks[0]).toEqual({ kind: 'list', label: { form, text: 'The holders' }, items: [{ form, text: 'First item.', cites: [REF] }, { form, text: 'Second item.', cites: [REF] }] });
    }
    const noLabel = written(viewAnswer({ blocks: [{ kind: 'list', items: [{ text: 'Only item.', cites: ['n1'] }] }] }), true).answer;
    expect(noLabel?.blocks[0]).not.toHaveProperty('label');
  });

  it('binds a value in an item of a list as it binds one in a sentence, and refuses a binding to an element the item does not cite', () => {
    const values = new Map([['n1', [{ key: 'holder', text: 'Jordan Lee', masked: false }]]]);
    const context: ClassifyContext = { sentValues: values, sent: ['n1'], typeOf: () => 'widget', sensitiveKeys: new Map([['widget', ['holder']]]) };
    const stored = storedAnswerOf(viewAnswer({ blocks: [{ kind: 'list', items: [{ text: 'Jordan Lee is listed.', cites: ['n1'] }] }] }), false, (text, cited) => classifyItem(text, cited, context));
    expect(stored?.answer.blocks[0]).toMatchObject({ kind: 'list', items: [{ form: 'bound' }] });
    expect(bindingsApproved(stored?.answer as never, context, stored?.keyOf as never, 'demo')).toBe(true);
    const swapped = JSON.parse(JSON.stringify(stored?.answer).replace('"property":"holder"', '"property":"other"')) as NonNullable<typeof stored>['answer'];
    expect(bindingsApproved(swapped, context, stored?.keyOf as never, 'demo')).toBe(false);
  });

  it('stores an answer of the server from the operator\'s text, a refusal of Ask and the cited summary of an Ask answer, each as the block that holds what the person saw', () => {
    const meaning = storedAnswerOf({ status: 'meaning', described: [{ typeKind: 'entity', type: 'widget', description: 'A thing that is sold.' }], noDescription: { sentence: 'The mapping gives gadget no description.', names: ['gadget'] } } as AssistantTurnAnswer, false)?.answer;
    expect(meaning?.blocks).toEqual([{ kind: 'sentences', items: [{ form: 'frozen', text: 'Entity type widget: A thing that is sold.', cites: [] }, { form: 'frozen', text: 'The mapping gives gadget no description.', cites: [] }] }]);
    const none = storedAnswerOf({ status: 'no-description', route: 'view', sentence: 'The mapping gives gadget no description.', names: ['gadget'] } as AssistantTurnAnswer, false)?.answer;
    expect(none?.blocks).toEqual([{ kind: 'sentences', items: [{ form: 'frozen', text: 'The mapping gives gadget no description.', cites: [] }] }]);
    const refused = storedAnswerOf({ status: 'answered', route: 'ask', answer: { refused: { cause: 'no-intent', sentence: 'That question is not one of this source.' } } } as unknown as AssistantTurnAnswer, false)?.answer;
    expect(refused?.blocks).toEqual([{ kind: 'refusal', sentence: { form: 'frozen', text: 'That question is not one of this source.' } }]);
    const lee = { ref: REF, display: { title: 'Jordan Lee', type: 'widget' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } };
    const entity = { templateId: 'entity', result: lee } as unknown as AskRunResult;
    const summary = buildSummary(entity);
    const asked = (maskOn: boolean) => storedAnswerOf({ status: 'answered', route: 'ask', answer: { answered: { intent: 'x', entities: {}, outcome: 'complete', result: entity, summary } } } as unknown as AssistantTurnAnswer, maskOn)?.answer;
    expect(asked(true)?.blocks[0]).toEqual({ kind: 'sentences', items: [{ form: 'frozen', text: 'Jordan Lee is of type widget.', cites: [REF] }] });
    expect(asked(false)?.blocks[0]).toEqual({ kind: 'sentences', items: [{ form: 'bound', segments: [{ element: REF, property: '(title)' }, { literal: ' is of type widget.' }], cites: [REF] }] });
    expect(asked(false)?.blocks[1]).toMatchObject({ kind: 'ask-result' });
    const node = { ref: REF, display: { title: 'Jordan Lee', type: 'widget' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } };
    const alone = (maskOn: boolean) => storedAnswerOf({ status: 'answered', route: 'ask', answer: { answered: { intent: 'x', entities: { widget: 'typed' }, outcome: 'complete', result: { templateId: 'entity', result: node } } } } as unknown as AssistantTurnAnswer, maskOn)?.answer;
    expect(alone(true)?.blocks).toEqual([expect.objectContaining({ kind: 'ask-result', values: [{ name: 'widget', text: 'typed' }], lines: [{ label: 'Entity', item: { form: 'frozen', text: 'Jordan Lee' } }] })]);
    expect(alone(false)?.blocks).toEqual([expect.objectContaining({ kind: 'ask-result', lines: [{ label: 'Entity', item: { form: 'ref', ref: REF } }] })]);
    expect(JSON.stringify(alone(false))).not.toContain('Jordan Lee');
  });

  describe('the cited summary of an Ask answer written with the mask off, built again with a sentinel for each title', () => {
    const nodeOf = (stableId: string, title: string, type = 'widget') => ({ ref: { ...REF, stableId }, display: { title, type }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
    const shared = (nodes: ReturnType<typeof nodeOf>[], over: Record<string, unknown> = {}): AskRunResult => ({ templateId: 'shared-attribute', result: { status: 'ok', templateId: 'shared-attribute', templateVersion: '1', count: { value: nodes.length - 1, quality: 'exact', scope: 'matches' }, matchIds: nodes.slice(1).map((node) => node.ref), nodes, edges: [], notices: [], warnings: [], ...over } }) as unknown as AskRunResult;
    const answered = (result: AskRunResult, summary: unknown = buildSummary(result)): AssistantTurnAnswer => ({ status: 'answered', route: 'ask', answer: { answered: { intent: 'x', entities: {}, outcome: 'complete', result, summary } } }) as unknown as AssistantTurnAnswer;
    const itemsOf = (stored: ReturnType<typeof storedAnswerOf>) => (stored?.answer.blocks[0]?.kind === 'sentences' ? stored.answer.blocks[0].items : []);
    const context: ClassifyContext = { sentValues: undefined, sent: [], typeOf: () => undefined, sensitiveKeys: undefined };
    const approved = (stored: ReturnType<typeof storedAnswerOf>, sourceId = 'demo') => bindingsApproved(stored?.answer as never, context, stored?.keyOf as never, sourceId);

    it('binds each title to the element it is, whatever the words and the type names say: a title equal to a type name, to an ordinary word, or to a number', () => {
      for (const titles of [['widget', 'widget'], ['is', 'shares'], ['1', '2']]) {
        const result = shared([nodeOf('a1', titles[0] as string), nodeOf('a2', titles[1] as string)]);
        const stored = storedAnswerOf(answered(result), false);
        const text = buildSummary(result)?.sentences[0]?.text ?? '';
        const [first] = itemsOf(stored);
        expect(first, text).toMatchObject({ form: 'bound' });
        const segments = (first as { segments: ({ literal: string } | { element: unknown })[] }).segments;
        // the words of the sentence stay literal, and each title is a binding to its own element
        expect(segments.filter((segment) => 'element' in segment).map((segment) => (segment as { element: { stableId: string } }).element.stableId).sort()).toEqual(['a1', 'a2']);
        expect(segments.some((segment) => 'literal' in segment && segment.literal.includes(' an attribute with '))).toBe(true);
        expect(approved(stored)).toBe(true);
      }
    });

    it('binds two elements that share a title each to its own, and a title in decomposed form like one in composed form', () => {
      const same = shared([nodeOf('a1', 'Jordan Lee'), nodeOf('a2', 'Jordan Lee')]);
      const [bound] = itemsOf(storedAnswerOf(answered(same), false));
      expect((bound as { segments: { element?: { stableId: string } }[] }).segments.flatMap((segment) => (segment.element === undefined ? [] : [segment.element.stableId])).sort()).toEqual(['a1', 'a2']);
      const mixed = shared([nodeOf('a1', 'Jose\u0301'), nodeOf('a2', 'Jos\u00e9')]);
      const stored = storedAnswerOf(answered(mixed), false);
      expect(JSON.stringify(itemsOf(stored))).not.toMatch(/Jos/u);
      expect(approved(stored)).toBe(true);
    });

    it('leaves a sentence unbound when it cannot be built again as it is: a shortened title, a title of an element it does not cite, and a summary that does not follow from the result', () => {
      const long = 'N'.repeat(45);
      const paths = { templateId: 'shortest-paths', result: { status: 'ok', paths: [{ hops: 1, steps: [{ from: { ...REF, stableId: 'p1' }, to: { ...REF, stableId: 'p2' }, relationshipType: 'LINKS', evidenceRefs: [] }] }], nodes: [nodeOf('p1', `${long}1`), nodeOf('p2', `${long}2`)], edges: [], capReached: false, partial: false, elapsedMs: 1, warnings: [] } } as unknown as AskRunResult;
      const heading = itemsOf(storedAnswerOf(answered(paths), false))[0];
      expect(heading?.form).toBe('unbound');
      expect(JSON.stringify(heading)).not.toContain('"form":"frozen"');
      // a summary that names an element the result does not hold: forged, so unbound and never bound to a title it invented
      const result = shared([nodeOf('a1', 'Jordan Lee'), nodeOf('a2', 'Maria Gomez')]);
      const forged = { sentences: [{ text: 'Secret shares an attribute with Jordan Lee.', cites: ['k1', 'k9'] }], citations: [{ key: 'k1', element: { ...REF, stableId: 'a1' }, type: 'widget', title: 'Jordan Lee' }, { key: 'k9', element: { ...REF, stableId: 'zz' }, type: 'widget', title: 'Secret' }] };
      const stored = storedAnswerOf(answered(result, forged), false);
      expect(itemsOf(stored)[0]).toMatchObject({ form: 'unbound' });
      // a sentence that cites fewer elements than it names is unbound
      const fewer = buildSummary(result);
      const cutCites = fewer === undefined ? undefined : { ...fewer, sentences: fewer.sentences.map((sentence) => ({ ...sentence, cites: sentence.cites.slice(0, 1) })), citations: fewer.citations };
      expect(itemsOf(storedAnswerOf(answered(result, cutCites), false))[0]).toMatchObject({ form: 'unbound' });
    });

    it('refuses the write as a whole when a stored binding was changed after it was made: a binding replaced by the literal title, a swapped property, another source, an element no title belongs to', () => {
      const result = shared([nodeOf('a1', 'Jordan Lee'), nodeOf('a2', 'Maria Gomez')]);
      const stored = storedAnswerOf(answered(result), false);
      const item = itemsOf(stored)[0] as { form: string; segments: ({ literal: string } | { element: unknown; property: string })[] };
      expect(item.form).toBe('bound');
      expect(approved(stored)).toBe(true);
      expect(approved(stored, 'another-source')).toBe(false);
      const original = JSON.stringify(item.segments);
      // the binding of the first title replaced in place by its literal text, the item keeping its place in the stored form
      const index = item.segments.findIndex((segment) => 'element' in segment);
      item.segments[index] = { literal: 'Jordan Lee' };
      expect(approved(stored)).toBe(false);
      item.segments = JSON.parse(original);
      expect(approved(stored)).toBe(true);
      const element = item.segments.find((segment) => 'element' in segment) as { property: string };
      element.property = 'holder';
      expect(approved(stored)).toBe(false);
    });

    it('instruments the ends of a derived relationship too, so that their titles are bound or the sentence is unbound, and never frozen in clear: builder, storage and masked read', () => {
      const end = (stableId: string, title: string) => ({ ref: { ...REF, stableId }, title, type: 'widget' });
      const derived = { templateId: 'derived-edge-support', result: { ref: { sourceId: 'demo', derived: { ruleId: 'r', from: { ...REF, stableId: 'a1' }, to: { ...REF, stableId: 'a2' } } }, type: 'LINKED', from: end('a1', 'Jordan Lee'), to: end('a2', 'Maria Gomez'), rule: { id: 'r', version: 1 }, supports: { count: { value: 0, quality: 'exact', scope: 's' }, groups: [] } } } as unknown as AskRunResult;
      const summary = buildSummary(derived);
      expect(summary?.sentences[0]?.text).toContain('Jordan Lee');
      const stored = storedAnswerOf({ status: 'answered', route: 'ask', answer: { answered: { intent: 'x', entities: {}, outcome: 'complete', result: derived, summary } } } as unknown as AssistantTurnAnswer, false);
      expect(JSON.stringify(itemsOf(stored))).not.toMatch(/Jordan|Maria/u);
      expect(approved(stored)).toBe(true);
      const turn = { id: '0192f000-0000-7000-8000-0000000000f2', seq: 1, at: '2026-11-18T10:00:00.000Z', route: 'ask' as const, outcome: 'answered' as const, citedElements: 2, steps: 0, stored: { maskOn: false, answer: stored?.answer, sensitivityVersion: 'sv1:a' } };
      const read = presentThread({ turns: [turn], earlierTurns: 0, previousThreadClearedAt: null } as never, true, 'sv1:a');
      expect(JSON.stringify(read)).not.toMatch(/Jordan|Maria/u);
    });

    it('finds the anchor of a run among elements that share a title by the citations too, not by the text alone', () => {
      const result = shared([nodeOf('a1', 'Same'), nodeOf('a2', 'Same')]);
      const second = { ...REF, stableId: 'a2' };
      const built = buildSummary(result, { anchor: second });
      const stored = storedAnswerOf(answered(result, built), false);
      expect(itemsOf(stored)[0]).toMatchObject({ form: 'bound' });
      expect(approved(stored)).toBe(true);
    });

    it('builds the summary again once for a template that does not name an anchor, and at most once for each candidate and never more than the tries allow for one that does', () => {
      const calls = vi.mocked(buildSummary);
      const many = Array.from({ length: 200 }, (_, index) => nodeOf(`n${index}`, `Title ${index}`));
      const fileQuery = { templateId: 'file-query', result: { status: 'ok', intent: 'q', count: { value: 200, quality: 'exact', scope: 's' }, nodes: many, edges: [], notices: [], warnings: [] } } as unknown as AskRunResult;
      const summary = buildSummary(fileQuery);
      calls.mockClear();
      storedAnswerOf(answered(fileQuery, summary), false);
      expect(calls).toHaveBeenCalledTimes(1);
      const run = shared(many);
      const anchored = buildSummary(run, { anchor: { ...REF, stableId: 'n150' } });
      calls.mockClear();
      storedAnswerOf(answered(run, anchored), false);
      expect(calls.mock.calls.length).toBeLessThanOrEqual(51);
    });

    it('stores every sentence frozen as it was shown when the mask was on', () => {
      const result = shared([nodeOf('a1', 'Jordan Lee'), nodeOf('a2', 'Maria Gomez')]);
      expect(itemsOf(storedAnswerOf(answered(result), true)).every((item) => item.form === 'frozen')).toBe(true);
    });
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

