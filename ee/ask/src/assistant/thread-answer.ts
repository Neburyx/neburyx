import type { AssistantThreadTurnWrite, AssistantTurnAnswer, StoredAnswer } from '@neburyx/contracts';
import { THREAD_SEGMENTS_MAX } from '@neburyx/contracts';
import type { Classified, ClassifyContext } from './sensitive-items.js';

type Cite = AssistantThreadTurnWrite['citationRefs'][number];
type Sentence = { readonly text: string; readonly cites: readonly string[] };
type Citation = { readonly key: string; readonly kind: string; readonly ref?: Cite };
type Block = StoredAnswer['blocks'][number];
type TextItem = { readonly form: 'frozen' | 'unbound'; readonly text: string };
type Item = TextItem | { form: 'bound'; segments: ({ literal: string } | { element: Cite; property: string })[] };

/** The element a key of an answer stands for, when the key is one of an element or a relationship (not a read, not a meaning); the references the thread already keeps. */
const refsOf = (citations: readonly Citation[]): Map<string, Cite> => new Map(citations.flatMap((citation) => (citation.ref === undefined || citation.kind === 'read' || citation.kind === 'description' ? [] : [[citation.key, citation.ref] as const])));

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
  return segments.length > THREAD_SEGMENTS_MAX || segments.length === 0 ? unbound : { form: 'bound', segments };
}

/**
 * The stored form of an answer that a turn ended with, or nothing for an answer that has no stored form yet. The fixed sentences of the server are kept as they are written, `frozen`, in either case. Only the answers that carry sentences, a
 * table or a refusal have a form here; the other shapes join when the answer is one list of blocks.
 */
export interface StoredAnswerResult {
  readonly answer: StoredAnswer;
  /** The key an element reference had in the answer, for checking a binding against the provenance of the turn. */
  readonly keyOf: (ref: Cite) => string | undefined;
}

export function storedAnswerOf(answer: AssistantTurnAnswer, maskOn: boolean, classify?: ClassifyItem): StoredAnswerResult | undefined {
  const fixed = (text: string): TextItem => ({ form: 'frozen', text });
  const citedRefs = (keys: readonly string[], refs: ReadonlyMap<string, Cite>): Cite[] => keys.flatMap((key) => (refs.has(key) ? [refs.get(key) as Cite] : []));
  const sentences = (list: readonly Sentence[], refs: ReadonlyMap<string, Cite>) =>
    list.map((sentence) => ({ ...itemOf(sentence.text, sentence.cites.filter((key) => refs.has(key)), refs, maskOn, 2000, classify), cites: citedRefs(sentence.cites, refs) }));
  const result = (blocks: Block[], refs: ReadonlyMap<string, Cite> = new Map()): StoredAnswerResult => {
    const inverse = new Map([...refs].map(([key, ref]) => [JSON.stringify(ref), key] as const));
    return { answer: { blocks }, keyOf: (ref) => inverse.get(JSON.stringify(ref)) };
  };
  if (answer.status === 'not-answered') return result([{ kind: 'refusal', sentence: fixed(answer.sentence) }]);
  if (answer.status !== 'answered') return undefined;
  if (answer.route === 'refuse') {
    const refs = answer.overview === undefined ? new Map<string, Cite>() : refsOf(answer.overview.citations);
    return result([{ kind: 'refusal', sentence: fixed(answer.sentence), ...(answer.overview === undefined ? {} : { overview: sentences(answer.overview.sentences, refs) }) }] as Block[], refs);
  }
  if (!('citations' in answer)) return undefined;
  const refs = refsOf(answer.citations);
  // the fixed sentences of the server (a type with no description, a pointer, the note of the last call) are a block of their own, kept as written
  const server = [answer.noDescription, answer.pointer, answer.lastCallNote].flatMap((text) => (text === undefined || text === '' ? [] : [{ ...fixed(text), cites: [] as Cite[] }]));
  const fixedBlock: Block[] = server.length === 0 ? [] : [{ kind: 'sentences', items: server }];
  if ('table' in answer) {
    const { table } = answer;
    const labels = table.columns.map((label) => ({ form: maskOn ? ('frozen' as const) : classify?.(label, [])?.form === 'frozen' ? ('frozen' as const) : ('unbound' as const), text: label }));
    const rows = table.rows.map((row) => ({ cells: row.cells.map((cell) => itemOf(cell, row.cites.filter((key) => refs.has(key)), refs, maskOn, 80, classify)), cites: citedRefs(row.cites, refs) }));
    return result([{ kind: 'table', columns: labels, rows }, ...fixedBlock], refs);
  }
  if (!('sentences' in answer)) return undefined;
  return result([{ kind: 'sentences', items: sentences(answer.sentences, refs) }, ...fixedBlock] as Block[], refs);
}

/**
 * Whether every binding of a stored answer is one the classifier could have approved for the elements this turn sent: the element is one that was sent, the property is one of its values and a sensitive key of its type. A strict schema cannot say
 * that (it has no provenance), so the write is validated here against the answer's own provenance, and refused as a whole when a binding is to anything else.
 */
export function bindingsApproved(stored: StoredAnswer, context: ClassifyContext, keyOf: (ref: Cite) => string | undefined): boolean {
  const bound = (item: { readonly form: string; readonly segments?: readonly unknown[] }): { element: Cite; property: string }[] => (item.form === 'bound' ? (item.segments ?? []).filter((segment): segment is { element: Cite; property: string } => typeof segment === 'object' && segment !== null && 'element' in segment) : []);
  const items = stored.blocks.flatMap((block) => (block.kind === 'sentences' ? block.items : block.kind === 'table' ? block.rows.flatMap((row) => row.cells) : block.overview ?? []));
  const bindings = items.flatMap((item) => bound(item as never));
  if (bindings.length === 0) return true;
  if (context.sentValues === undefined || context.sensitiveKeys === undefined) return false;
  return bindings.every((binding) => {
    const key = keyOf(binding.element);
    const type = key === undefined ? undefined : context.typeOf(key);
    const values = key === undefined ? undefined : context.sentValues?.get(key);
    return type !== undefined && values?.some((value) => value.key === binding.property && !value.masked) === true && context.sensitiveKeys?.get(type)?.includes(binding.property) === true;
  });
}
