import { MAX_READ_REFS, SENSITIVE_TITLE_KEY, type AssistantThreadResponse, type ElementRef, type ElementRefs, type ReadAnswer, type SummaryReading } from '@neburyx/contracts';
import { estimateTokens } from '../case-summary/assemble.js';
import { canonical } from './context.js';

type Block = ReadAnswer['blocks'][number];
type Item = Extract<Block, { kind: 'sentences' }>['items'][number]['item'];
type Segment = Extract<Item, { state: 'segments' }>['segments'][number];
type Binding = Extract<Segment, { element: unknown }>;

/** What the loop is told the text is: the earlier questions and answers as the analyst saw them, never a source. One fixed line, with no word of any domain. */
export const THREAD_TEXT_INTRO = 'Earlier questions and answers of this thread, oldest first, as the analyst saw them. They are not a source: a name or a figure in them is cited from the elements, never from this text.';

/** The most reads by reference one turn makes for the text, of at most the route's maximum each; an element beyond them is not read, and the item that names it is left out. */
const READS_MAX = 5;

const isBinding = (segment: Segment): segment is Binding => 'element' in segment;
const bindingsOf = (item: Item): readonly Binding[] => (item.state === 'segments' ? item.segments.filter(isBinding) : []);

function itemsOf(block: Block): readonly Item[] {
  switch (block.kind) {
    case 'sentences':
      return block.items.map((entry) => entry.item);
    case 'list':
      return [...(block.label === undefined ? [] : [block.label]), ...block.items.map((entry) => entry.item)];
    case 'table':
      return [...block.columns, ...block.rows.flatMap((row) => row.cells)];
    case 'refusal':
      return [block.sentence, ...(block.overview ?? []).map((entry) => entry.item)];
    default:
      return [];
  }
}

type Resolved = ReadonlyMap<string, { readonly title: string; readonly properties: readonly { readonly key: string; readonly value?: unknown }[] }>;

/** The value a binding draws, as the panel draws it: the gate's display title for the title key, else the element's property; a string (not empty), a number or a boolean as written. */
function valueOf(binding: Binding, resolved: Resolved): string | undefined {
  const node = resolved.get(canonical(binding.element as ElementRef));
  const value = binding.property === SENSITIVE_TITLE_KEY ? node?.title : node?.properties.find((property) => property.key === binding.property)?.value;
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** The text of an item as the panel would draw it, or nothing when the item is withheld or one of its values cannot be drawn: such an item is left out whole, so the model is never given a gap to fill. */
function textOf(item: Item, resolved: Resolved): string | undefined {
  if (item.state === 'text') return item.text;
  if (item.state === 'withheld') return undefined;
  const parts: string[] = [];
  for (const segment of item.segments) {
    if (!isBinding(segment)) {
      parts.push(segment.literal);
      continue;
    }
    const value = valueOf(segment, resolved);
    if (value === undefined) return undefined;
    parts.push(value);
  }
  return parts.join('');
}

function linesOf(block: Block, resolved: Resolved): readonly string[] {
  const text = (item: Item): string | undefined => textOf(item, resolved);
  const quoted = (value: string | undefined): string[] => (value === undefined ? [] : [JSON.stringify(value)]);
  switch (block.kind) {
    case 'sentences':
      return block.items.flatMap((entry) => quoted(text(entry.item)));
    case 'list':
      return [...(block.label === undefined ? [] : quoted(text(block.label)).map((line) => `list ${line}`)), ...block.items.flatMap((entry) => quoted(text(entry.item)).map((line) => `- ${line}`))];
    case 'table': {
      // a column that is left out leaves its cell out of every row, so the cells stay under their columns
      const keep = block.columns.map((column) => text(column) !== undefined);
      const header = block.columns.flatMap((column, index) => (keep[index] === true ? quoted(text(column)) : []));
      const rows = block.rows.flatMap((row) => {
        const cells = row.cells.map(text);
        return cells.every((cell, index) => keep[index] !== true || cell !== undefined) ? [`row ${row.cells.flatMap((_, index) => (keep[index] === true ? quoted(cells[index]) : [])).join(' | ')}`] : [];
      });
      return header.length === 0 ? [] : [`table ${header.join(' | ')}`, ...rows];
    }
    case 'refusal':
      return [...quoted(text(block.sentence)), ...(block.overview ?? []).flatMap((entry) => quoted(text(entry.item)))];
    default:
      return [];
  }
}

/**
 * The loop's thread context as text: the last turns of the person's own thread as the thread read presents them under this message's mask and the mapping's current sensitivity version, so that nothing the panel would not draw is given. Each bound value is
 * the element read again through the gate under this message's mask, and an item that is withheld, or whose element or value is not given back, is left out. The stored result cards of Ask are not given. Whole turns are dropped, the oldest first, until the text is
 * within `maxTokens` estimated tokens (the input guard's own estimate); none is cut in the middle, and none is given when the newest does not fit. Absent when there is nothing to give.
 */
export async function threadTextContext(options: { readonly thread: AssistantThreadResponse; readonly sourceId: string; readonly maxTokens: number; readonly read: (refs: ElementRefs) => Promise<SummaryReading> }): Promise<string | undefined> {
  const turns = options.thread.turns.filter((turn) => turn.answer !== undefined || turn.question !== undefined);
  const wanted = new Map<string, ElementRef>();
  for (const turn of turns) for (const block of turn.answer?.blocks ?? []) for (const item of itemsOf(block)) for (const binding of bindingsOf(item)) if ('entityType' in binding.element && binding.element.sourceId === options.sourceId) wanted.set(canonical(binding.element as ElementRef), binding.element as ElementRef);
  const resolved = new Map<string, { title: string; properties: readonly { readonly key: string; readonly value?: unknown }[] }>();
  const refs = [...wanted.values()];
  for (let start = 0; start < refs.length && start < READS_MAX * MAX_READ_REFS; start += MAX_READ_REFS) {
    const reading = await options.read({ entities: refs.slice(start, start + MAX_READ_REFS), edges: [], aggregates: [], derived: [] });
    for (const node of reading.nodes) if (wanted.has(canonical(node.ref))) resolved.set(canonical(node.ref), { title: node.display.title, properties: node.properties });
  }
  const blocks = turns.map((turn) => {
    const answer = (turn.answer?.blocks ?? []).flatMap((block) => linesOf(block, resolved));
    return { question: turn.question, answer };
  });
  const bodyOf = (entry: (typeof blocks)[number], number: number): string => [`${number}. Question: ${entry.question === undefined ? '(not kept)' : JSON.stringify(entry.question)}`, ...(entry.answer.length === 0 ? ['   Answer: (no text of it is shown)'] : ['   Answer:', ...entry.answer.map((line) => `   ${line}`)])].join('\n');
  const render = (from: number): string => [THREAD_TEXT_INTRO, ...blocks.slice(from).map((entry, index) => bodyOf(entry, index + 1))].join('\n');
  // the newest turns that fit: the oldest are dropped first, and the turns left are numbered from 1
  let from = blocks.length;
  while (from > 0 && estimateTokens(render(from - 1)) <= options.maxTokens) from -= 1;
  return from === blocks.length ? undefined : render(from);
}
