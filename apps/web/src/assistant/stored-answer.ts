import type { ElementRef, ReadAnswer } from '@neburyx/contracts';
import { elementKey } from '../state/keys.js';
import type { CitationEntry } from '../summary/summary-model.js';
import { ASSISTANT_COPY } from './copy.js';
import { refKeyOf, type RefReads } from './stored-reads.js';
import type { ViewAnswer } from './assistant-session.js';

type Block = ReadAnswer['blocks'][number];
type Item = Extract<Block, { kind: 'sentences' }>['items'][number]['item'];
type Cited = Extract<Block, { kind: 'sentences' }>['items'][number]['cites'][number];
type Segment = Extract<Item, { state: 'segments' }>['segments'][number];
type Binding = Extract<Segment, { element: unknown }>;

/** The value a binding draws, or nothing when it cannot be drawn (the element is missing, holds no such property, or has not been read). */
export type ValueOf = (binding: Binding) => string | undefined;

const isBinding = (segment: Segment): segment is Binding => 'element' in segment;

/** The text a stored item draws: its text, its literal pieces with the value of each binding as `valueFor` gives it (or the unavailable mark), or the masking notice for an item the read withheld. */
function itemTextOf(item: Item, valueFor: ValueOf): string {
  if (item.state === 'text') return item.text;
  if (item.state === 'withheld') return ASSISTANT_COPY.storedWithheld;
  return item.segments.map((segment) => (isBinding(segment) ? (valueFor(segment) ?? ASSISTANT_COPY.valueUnavailable) : segment.literal)).join('');
}

/** What the card draws of a stored answer: its blocks as a live answer's (the fixed sentence and the overview of a refusal beside them), and the cited elements numbered in the order they are first cited. */
export interface StoredView {
  readonly blocks: ViewAnswer['blocks'];
  readonly refusals: readonly { readonly sentence: string; readonly overview: ViewAnswer['blocks'] | undefined }[];
  readonly entries: readonly CitationEntry[];
}

export function storedViewOf(answer: ReadAnswer, valueFor: ValueOf): StoredView {
  const numbers = new Map<string, CitationEntry>();
  const keyOf = (ref: Cited): string => {
    const known = numbers.get(refKeyOf(ref));
    if (known !== undefined) return known.key;
    const number = numbers.size + 1;
    numbers.set(refKeyOf(ref), { key: String(number), number, kind: 'entityType' in ref ? 'entity' : 'relationship', graphKey: refKeyOf(ref), label: undefined });
    return String(number);
  };
  const sentencesOf = (items: readonly { readonly item: Item; readonly cites: readonly Cited[] }[]) => items.map((each) => ({ text: itemTextOf(each.item, valueFor), cites: each.cites.map(keyOf) }));
  const blocks: ViewAnswer['blocks'][number][] = [];
  const refusals: StoredView['refusals'][number][] = [];
  for (const block of answer.blocks) {
    if (block.kind === 'sentences') blocks.push({ kind: 'sentences', sentences: sentencesOf(block.items) } as ViewAnswer['blocks'][number]);
    else if (block.kind === 'table') {
      const columns = block.columns.map((column) => (column.state === 'text' ? column.text : ASSISTANT_COPY.storedWithheld));
      blocks.push({ kind: 'table', table: { title: '', columns, rows: block.rows.map((row) => ({ cells: row.cells.map((cell) => itemTextOf(cell, valueFor)), cites: row.cites.map(keyOf) })), note: '' } } as ViewAnswer['blocks'][number]);
    } else {
      const overview = block.overview === undefined ? undefined : ([{ kind: 'sentences', sentences: sentencesOf(block.overview) }] as unknown as ViewAnswer['blocks']);
      refusals.push({ sentence: block.sentence.state === 'text' ? block.sentence.text : ASSISTANT_COPY.storedWithheld, overview });
    }
  }
  return { blocks, refusals, entries: [...numbers.values()] };
}

/** The value a binding draws from what the gate returned for its element under the current mask, as the text a live answer writes it: a string, a number or a boolean as it is. Nothing when the element was not returned, holds no such property, or holds a value of another kind. */
export const valueFromReads = (reads: Pick<RefReads, 'nodes'>): ValueOf => (binding) => {
  const value = reads.nodes.get(elementKey(binding.element as ElementRef))?.properties.find((property) => property.key === binding.property)?.value;
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
};

/** The elements whose values the shown answers draw: each element a binding names, once, in the order first named. */
export function boundElementsOf(answers: readonly ReadAnswer[]): ElementRef[] {
  const seen = new Map<string, ElementRef>();
  const itemsOf = (block: Block): Item[] =>
    block.kind === 'sentences' ? block.items.map((each) => each.item) : block.kind === 'table' ? [...block.columns, ...block.rows.flatMap((row) => row.cells)] : [block.sentence, ...(block.overview ?? []).map((each) => each.item)];
  for (const answer of answers)
    for (const item of answer.blocks.flatMap(itemsOf))
      if (item.state === 'segments') for (const segment of item.segments) if (isBinding(segment) && 'entityType' in segment.element) seen.set(refKeyOf(segment.element), segment.element);
  return [...seen.values()];
}
