import { pluralOf, SENSITIVE_TITLE_KEY, tableNote, tableRowsPhrase, tableTitle, tableUnitClause, type EdgeRef, type ElementRef, type ReadAnswer, type ReadAskResult, type SourceProfile } from '@neburyx/contracts';
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
  /** The results of Ask the answer holds, in order. */
  readonly askResults: readonly ReadAskResult[];
  /** The elements the answer cites, in the order they are first cited, as references (what a read by reference is asked for). */
  readonly refs: readonly Cited[];
  readonly blocks: ViewAnswer['blocks'];
  readonly refusals: readonly { readonly sentence: string; readonly overview: ViewAnswer['blocks'] | undefined }[];
  readonly entries: readonly CitationEntry[];
}

type StoredTableBlock = Extract<Block, { kind: 'table' }>;

/**
 * The title a stored table draws, written from what was stored and the current mapping as the live one was: "<plural of the type> [of <the element the rows were listed from>] · <n> rows". The plural comes from the display name of the type in the mapping, "Elements" when the rows
 * were about several types or about relationships and when the type is no longer in the mapping (never the key as if it were a name); the anchor is drawn when it was kept and may be shown, and as an ellipsis when the read withheld it (so the caption does not read as a table of everything). A table stored before the caption was kept says only the count of the rows it holds, which is true.
 */
export function captionOf(table: StoredTableBlock, profile: SourceProfile | undefined): string {
  const { caption } = table;
  if (caption === undefined) return tableRowsPhrase(table.rows.length);
  const type = caption.subject === undefined ? undefined : profile?.entityTypes.find((entry) => entry.type === caption.subject);
  const plural = type === undefined ? 'Elements' : pluralOf(type.displayName);
  return tableTitle(plural, table.rows.length, caption.anchor === undefined ? undefined : caption.anchor.state === 'text' ? caption.anchor.text : ASSISTANT_COPY.storedAnchorWithheld);
}

/** The note a stored table draws: a clause "<label> in <unit>." for each property the mapping still gives a unit (once each), then the fixed sentence. */
export function noteOf(table: StoredTableBlock, profile: SourceProfile | undefined): string {
  const clauses: string[] = [];
  for (const unit of table.units ?? []) {
    const shown = profile?.entityTypes.find((entry) => entry.type === unit.type)?.propertyDisplay?.[unit.property];
    if (shown?.unit === undefined) continue;
    const clause = tableUnitClause(shown.label, unit.property, shown.unit);
    if (!clauses.includes(clause)) clauses.push(clause);
  }
  return tableNote(clauses);
}

export function storedViewOf(answer: ReadAnswer, valueFor: ValueOf, profile?: SourceProfile): StoredView {
  const numbers = new Map<string, CitationEntry>();
  const refsByKey = new Map<string, Cited>();
  const keyOf = (ref: Cited): string => {
    const known = numbers.get(refKeyOf(ref));
    if (known !== undefined) return known.key;
    const number = numbers.size + 1;
    refsByKey.set(refKeyOf(ref), ref);
    numbers.set(refKeyOf(ref), { key: String(number), number, kind: 'entityType' in ref ? 'entity' : 'relationship', graphKey: refKeyOf(ref), label: undefined });
    return String(number);
  };
  const sentencesOf = (items: readonly { readonly item: Item; readonly cites: readonly Cited[] }[]) => items.map((each) => ({ text: itemTextOf(each.item, valueFor), cites: each.cites.map(keyOf) }));
  const blocks: ViewAnswer['blocks'][number][] = [];
  const refusals: StoredView['refusals'][number][] = [];
  const askResults: ReadAskResult[] = [];
  for (const block of answer.blocks) {
    if (block.kind === 'ask-result') askResults.push(block);
    else if (block.kind === 'sentences') blocks.push({ kind: 'sentences', sentences: sentencesOf(block.items) } as ViewAnswer['blocks'][number]);
    else if (block.kind === 'list') blocks.push({ kind: 'list', ...(block.label === undefined ? {} : { label: block.label.state === 'text' ? block.label.text : ASSISTANT_COPY.storedWithheld }), items: sentencesOf(block.items) } as ViewAnswer['blocks'][number]);
    else if (block.kind === 'table') {
      const columns = block.columns.map((column) => (column.state === 'text' ? column.text : ASSISTANT_COPY.storedWithheld));
      blocks.push({ kind: 'table', table: { title: captionOf(block, profile), ...(block.droppedRows === undefined ? {} : { droppedRows: block.droppedRows }), ...(block.moreNotShown === undefined ? {} : { moreNotShown: block.moreNotShown }), columns, rows: block.rows.map((row) => ({ cells: row.cells.map((cell) => itemTextOf(cell, valueFor)), cites: row.cites.map(keyOf) })), note: noteOf(block, profile) } } as ViewAnswer['blocks'][number]);
    } else {
      const overview = block.overview === undefined ? undefined : ([{ kind: 'sentences', sentences: sentencesOf(block.overview) }] as unknown as ViewAnswer['blocks']);
      refusals.push({ sentence: block.sentence.state === 'text' ? block.sentence.text : ASSISTANT_COPY.storedWithheld, overview });
    }
  }
  return { askResults, blocks, refusals, entries: [...numbers.values()], refs: [...numbers.values()].flatMap((entry) => (refsByKey.has(entry.graphKey) ? [refsByKey.get(entry.graphKey) as Cited] : [])) };
}

/** The value a binding draws from what the gate returned for its element under the current mask, as the text a live answer writes it: a string, a number or a boolean as it is. Nothing when the element was not returned, holds no such property, or holds a value of another kind. */
export const valueFromReads = (reads: Pick<RefReads, 'nodes'>): ValueOf => (binding) => {
  const node = reads.nodes.get(elementKey(binding.element as ElementRef));
  // the title is not one of the properties: it is the gate's own display title, masked as the gate masked it
  const value = binding.property === SENSITIVE_TITLE_KEY ? node?.display.title : node?.properties.find((property) => property.key === binding.property)?.value;
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
};

/** The elements the shown answers draw from a read by reference: each element a binding names and each element a stored result of Ask holds as a reference, once, in the order first named. */
export function boundElementsOf(answers: readonly ReadAnswer[]): (ElementRef | EdgeRef)[] {
  const seen = new Map<string, ElementRef | EdgeRef>();
  const add = (ref: ElementRef | EdgeRef): void => void seen.set(refKeyOf(ref), ref);
  const itemsOf = (block: Exclude<Block, { kind: 'ask-result' }>): Item[] =>
    block.kind === 'sentences' || block.kind === 'list' ? block.items.map((each) => each.item) : block.kind === 'table' ? [...block.columns, ...block.rows.flatMap((row) => row.cells)] : [block.sentence, ...(block.overview ?? []).map((each) => each.item)];
  for (const answer of answers)
    for (const block of answer.blocks) {
      if (block.kind === 'ask-result') {
        for (const row of block.rows) if (row.form === 'ref') add(row.ref);
        for (const line of block.lines) if (line.item?.form === 'ref') add(line.item.ref);
        for (const path of block.paths) for (const step of path.steps) for (const end of [step.from, step.to]) if (end.form === 'ref') add(end.ref);
        continue;
      }
      for (const item of itemsOf(block)) if (item.state === 'segments') for (const segment of item.segments) if (isBinding(segment) && 'entityType' in segment.element) add(segment.element);
    }
  return [...seen.values()];
}
