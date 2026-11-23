import type { AssistantThreadTurnWrite, AssistantTurnAnswer, StoredAnswer } from '@neburyx/contracts';
import { THREAD_SEGMENTS_MAX } from '@neburyx/contracts';
import { classifyItem, type Classified, type ClassifyContext } from './sensitive-items.js';

type Cite = AssistantThreadTurnWrite['citationRefs'][number];
type Sentence = { readonly text: string; readonly cites: readonly string[] };
type Citation = { readonly key: string; readonly kind: string; readonly ref?: Cite };
type Block = StoredAnswer['blocks'][number];
type TextItem = { readonly form: 'frozen' | 'unbound'; readonly text: string };
type Item = TextItem | { form: 'bound'; segments: ({ literal: string } | { element: Cite; property: string })[] };

/** The element a key of an answer stands for, when the key is one of an element or a relationship (not a read, not a meaning); the references the thread already keeps. */
const refsOf = (citations: readonly Citation[]): Map<string, Cite> => new Map(citations.flatMap((citation) => (citation.ref === undefined || citation.kind === 'read' || citation.kind === 'description' ? [] : [[citation.key, citation.ref] as const])));

/** The text an item was made from, by the item the conversion made: what a binding is checked against, since a bound item keeps none of its values. */
const ORIGINAL = new WeakMap<object, string>();

/** How an item of an answer written with the mask off is classified, by its text and the keys of the elements it cites; absent, every such item is `unbound`. */
export type ClassifyItem = (text: string, cited: readonly string[]) => Classified;

/**
 * The stored form of an item: a turn written with the mask on is stored as it was shown, `frozen`; one written with it off as its classification says: `frozen`, `bound` (literal pieces and, in place of each sensitive value, the element reference
 * and the property key; the value itself is never kept) or `unbound` (as written, whole). A text longer than its bound, an element with no reference and an item that would need more than `THREAD_SEGMENTS_MAX` segments are `unbound`: the first is
 * then refused by the schema, so that the bounds apply to the text as written and never to what the conversion leaves.
 */
function itemOf(text: string, cited: readonly string[], refs: ReadonlyMap<string, Cite>, maskOn: boolean, max: number, classify: ClassifyItem | undefined): Item {
  if (maskOn) return { form: 'frozen', text };
  const unbound: Item = { form: 'unbound', text };
  if (text.length > max || classify === undefined) return unbound;
  const classified = classify(text, cited);
  if (classified.form === 'frozen') return { form: 'frozen', text };
  if (classified.form === 'unbound') return unbound;
  const written = text.normalize('NFC');
  const segments: ({ literal: string } | { element: Cite; property: string })[] = [];
  let at = 0;
  for (const span of classified.spans) {
    const element = refs.get(span.element);
    if (element === undefined) return unbound;
    if (span.start > at) segments.push({ literal: written.slice(at, span.start) });
    segments.push({ element, property: span.property });
    at = span.end;
  }
  if (at < written.length) segments.push({ literal: written.slice(at) });
  const item: Item = segments.length > THREAD_SEGMENTS_MAX || segments.length === 0 ? unbound : { form: 'bound', segments };
  ORIGINAL.set(item, text);
  return item;
}

/**
 * The stored form of an answer that a turn ended with, or nothing for an answer that has no stored form yet. The fixed sentences of the server are kept as they are written, `frozen`, in either case. Only the answers that carry blocks (sentences and tables) or a refusal have a form here.
 */
export interface StoredAnswerResult {
  readonly answer: StoredAnswer;
  /** The key an element reference had in the answer, for checking a binding against the provenance of the turn. */
  readonly keyOf: (ref: Cite) => string | undefined;
}

const withMade = (result: StoredAnswerResult, made: Pick<StoredAnswer, 'model' | 'coverage'>): StoredAnswerResult => ({ ...result, answer: { ...made, ...result.answer } });

/** The stored form of Ask's own answer inside a turn: its refusal as a refusal block, and its cited summary as a block of sentences, written with the mask on as frozen and otherwise as written (unbound, since nothing was sent to a model to classify them against). */
function askAnswerStored(ask: Extract<AssistantTurnAnswer, { answer: unknown }>['answer'], maskOn: boolean, result: (blocks: Block[], refs?: ReadonlyMap<string, Cite>) => StoredAnswerResult, sentences: (list: readonly Sentence[], refs: ReadonlyMap<string, Cite>) => unknown[]): StoredAnswerResult | undefined {
  if ('refused' in ask) return result([{ kind: 'refusal', sentence: { form: 'frozen', text: ask.refused.sentence } }]);
  const { summary } = ask.answered;
  if (summary === undefined) return undefined;
  const refs = new Map(summary.citations.map((citation) => [citation.key, citation.element] as const));
  return result([{ kind: 'sentences', items: sentences(summary.sentences, refs) }] as Block[], refs);
}

export function storedAnswerOf(answer: AssistantTurnAnswer, maskOn: boolean, classify?: ClassifyItem): StoredAnswerResult | undefined {
  const fixed = (text: string): TextItem => ({ form: 'frozen', text });
  const citedRefs = (keys: readonly string[], refs: ReadonlyMap<string, Cite>): Cite[] => keys.flatMap((key) => (refs.has(key) ? [refs.get(key) as Cite] : []));
  const sentences = (list: readonly Sentence[], refs: ReadonlyMap<string, Cite>) =>
    list.map((sentence) => {
      const item = itemOf(sentence.text, sentence.cites.filter((key) => refs.has(key)), refs, maskOn, 2000, classify);
      const withCites = { ...item, cites: citedRefs(sentence.cites, refs) };
      ORIGINAL.set(withCites, sentence.text);
      return withCites;
    });
  const labelItem = (label: string): TextItem => ({ form: maskOn ? 'frozen' : classify?.(label, [])?.form === 'frozen' ? 'frozen' : 'unbound', text: label });
  const result = (blocks: Block[], refs: ReadonlyMap<string, Cite> = new Map()): StoredAnswerResult => {
    const inverse = new Map([...refs].map(([key, ref]) => [JSON.stringify(ref), key] as const));
    return { answer: { blocks }, keyOf: (ref) => inverse.get(JSON.stringify(ref)) };
  };
  if (answer.status === 'not-answered') return result([{ kind: 'refusal', sentence: fixed(answer.sentence) }]);
  // what the server answers from the operator's own text, with no model and no element: each type and its description, and the fixed sentence for the types that have none
  if (answer.status === 'meaning') {
    const described = answer.described.map((entry) => ({ ...fixed(`${entry.typeKind === 'entity' ? 'Entity' : 'Relationship'} type ${entry.type}: ${entry.description}`), cites: [] as Cite[] }));
    const missing = answer.noDescription === undefined ? [] : [{ ...fixed(answer.noDescription.sentence), cites: [] as Cite[] }];
    return result([{ kind: 'sentences', items: [...described, ...missing] }] as Block[]);
  }
  if (answer.status === 'no-description') return result([{ kind: 'sentences', items: [{ ...fixed(answer.sentence), cites: [] as Cite[] }] }] as Block[]);
  if (answer.status !== 'answered') return undefined;
  if ('answer' in answer) return askAnswerStored(answer.answer, maskOn, result, sentences);
  if (answer.route === 'refuse') {
    const refs = answer.overview === undefined ? new Map<string, Cite>() : refsOf(answer.overview.citations);
    return result([{ kind: 'refusal', sentence: fixed(answer.sentence), ...(answer.overview === undefined ? {} : { overview: sentences(answer.overview.sentences, refs) }) }] as Block[], refs);
  }
  if (!('citations' in answer)) return undefined;
  const refs = refsOf(answer.citations);
  // the fixed sentences of the server (a type with no description, a pointer, the note of the last call) are a block of their own, kept as written
  const server = [answer.noDescription, answer.pointer, answer.lastCallNote].flatMap((text) => (text === undefined || text === '' ? [] : [{ ...fixed(text), cites: [] as Cite[] }]));
  const fixedBlock: Block[] = server.length === 0 ? [] : [{ kind: 'sentences', items: server }];
  if (!('blocks' in answer)) return undefined;
  const stored: Block[] = answer.blocks.map((block): Block => {
    if (block.kind === 'sentences') return { kind: 'sentences', items: sentences(block.sentences, refs) } as Block;
    if (block.kind === 'list') return { kind: 'list', ...(block.label === undefined ? {} : { label: labelItem(block.label) }), items: sentences(block.items, refs) } as Block;
    const { table } = block;
    const labels = table.columns.map((label) => ({ form: maskOn ? ('frozen' as const) : classify?.(label, [])?.form === 'frozen' ? ('frozen' as const) : ('unbound' as const), text: label }));
    const rows = table.rows.map((row) => ({ cells: row.cells.map((cell) => itemOf(cell, row.cites.filter((key) => refs.has(key)), refs, maskOn, 80, classify)), cites: citedRefs(row.cites, refs) }));
    return { kind: 'table', columns: labels, rows };
  });
  // how the answer was made, as the server wrote it: counts and type names, no value
  const made = { model: answer.model, coverage: { retrieval: answer.coverage.retrieval, summary: answer.coverage.summary, ...('summaryCited' in answer.coverage && answer.coverage.summaryCited !== undefined ? { summaryCited: answer.coverage.summaryCited } : {}) } };
  return withMade(result([...stored, ...fixedBlock], refs), made);
}

/**
 * Whether every binding of a stored answer is the one the classifier approves for its item, for the elements this turn sent: each bound item is rebuilt, its literals and the value sent for each binding (the element's key and the property, from the
 * provenance), and classified again with the keys of the elements the item cites; it must come out `bound` with the same spans, and every binding is to an element of the turn's source. A strict schema cannot say that (it has no provenance), so the
 * write is validated here, and refused as a whole when a binding is to anything else: another property the element holds, an element cited only by another item, an element of another source, or no provenance at all.
 */
export function bindingsApproved(stored: StoredAnswer, context: ClassifyContext, keyOf: (ref: Cite) => string | undefined, sourceId: string | undefined): boolean {
  type Segment = { readonly literal: string } | { readonly element: Cite; readonly property: string };
  const itemsOf = (block: Block): { readonly item: { readonly form: string; readonly segments?: readonly Segment[] }; readonly cites: readonly Cite[] }[] =>
    block.kind === 'sentences' || block.kind === 'list' ? block.items.map((item) => ({ item, cites: item.cites })) : block.kind === 'table' ? block.rows.flatMap((row) => row.cells.map((item) => ({ item, cites: row.cites }))) : (block.overview ?? []).map((item) => ({ item, cites: item.cites }));
  for (const { item, cites } of stored.blocks.flatMap(itemsOf)) {
    if (item.form !== 'bound') continue;
    if (context.sentValues === undefined || context.sensitiveKeys === undefined) return false;
    let text = '';
    const expected: { start: number; end: number; element: string; property: string }[] = [];
    for (const segment of item.segments ?? []) {
      if ('literal' in segment) {
        text += segment.literal;
        continue;
      }
      const key = keyOf(segment.element);
      const sent = key === undefined ? undefined : context.sentValues.get(key)?.find((value) => value.key === segment.property && !value.masked)?.text;
      if (key === undefined || sent === undefined || (sourceId !== undefined && (segment.element as { sourceId?: string }).sourceId !== sourceId)) return false;
      const start = text.length;
      text += sent.normalize('NFC').trim();
      expected.push({ start, end: text.length, element: key, property: segment.property });
    }
    const cited = cites.flatMap((ref) => {
      const key = keyOf(ref);
      return key === undefined ? [] : [key];
    });
    // the item is rebuilt from its bindings: it must read as the text it was made from, so that a binding to another property or element that holds another value is refused
    if (ORIGINAL.get(item)?.normalize('NFC') !== text) return false;
    const again = classifyItem(text, cited, context);
    if (again.form !== 'bound' || JSON.stringify(again.spans) !== JSON.stringify(expected)) return false;
  }
  return true;
}
