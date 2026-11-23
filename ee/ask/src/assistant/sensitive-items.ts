import type { SentValue } from '../case-summary/assemble.js';

/** What the classifier reads of the turn: the values sent for every element (structured pairs, parsed from no line), the entity type of each element key, and the sensitive keys of the mapping per entity type. Any of them absent means nothing can be said to be free of sensitive values. */
export interface ClassifyContext {
  readonly sentValues: ReadonlyMap<string, readonly SentValue[]> | undefined;
  /** The keys of every element sent, cited or not: each must have its values in `sentValues`, or the provenance is incomplete. */
  readonly sent: readonly string[];
  /** The entity type of an element key; undefined for a relationship, which has no sensitive key. */
  readonly typeOf: (elementKey: string) => string | undefined;
  readonly sensitiveKeys: ReadonlyMap<string, readonly string[]> | undefined;
}

/** A sensitive value in an item that is the whole value of one property of one cited element: where it stands in the text of the item (offsets in the text as written, end excluded) and whose it is. */
interface BoundSpan {
  readonly start: number;
  readonly end: number;
  readonly element: string;
  readonly property: string;
}

/**
 * How an item of an answer written with the mask off may be kept: `frozen` when no sensitive value of any element sent occurs in it, whole or partial; `bound` when each sensitive value in it is the whole value of one property of exactly one
 * cited element (the spans are listed); `unbound` otherwise, which is also the answer whenever the metadata or the provenance is not there. A word of a sensitive value, a number written with other separators, a value of an element the item
 * does not cite and a value that two elements or two properties share make the item `unbound`. Everything here is read from the mapping's keys and the values sent; no name of a type or a property is in the code.
 */
export type Classified = { readonly form: 'frozen' } | { readonly form: 'unbound' } | { readonly form: 'bound'; readonly spans: readonly BoundSpan[] };

const UNBOUND: Classified = { form: 'unbound' };
const LETTERS = /[\p{L}\p{N}]+/gu;
const edge = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');

/** The shortest word of a sensitive value that counts as a part of it: a shorter one (an initial, a particle) is in too much ordinary text to tell. */
const WORD_MIN = 3;
/** The fewest digits of a number that count as a value whatever the separators written between them. */
const DIGITS_MIN = 4;

export function classifyItem(text: string, cited: readonly string[], context: ClassifyContext): Classified {
  const { sentValues, sensitiveKeys } = context;
  if (sentValues === undefined || sensitiveKeys === undefined) return UNBOUND;
  if (context.sent.some((key) => !sentValues.has(key)) || cited.some((key) => !sentValues.has(key))) return UNBOUND;
  const written = text.normalize('NFC');
  const folded = written.toLowerCase();
  // a case fold that moves the offsets would put a span in the wrong place: the item is not bound
  if (folded.length !== written.length) return UNBOUND;
  const owners = new Map<string, { element: string; property: string }[]>();
  for (const [element, values] of sentValues) {
    const type = context.typeOf(element);
    const keys = type === undefined ? undefined : sensitiveKeys.get(type);
    if (keys === undefined) continue;
    for (const value of values) {
      const text = value.text.normalize('NFC').toLowerCase().trim();
      if (!keys.includes(value.key) || value.masked || text === '') continue;
      const held = owners.get(text) ?? [];
      if (!held.some((owner) => owner.element === element && owner.property === value.key)) held.push({ element, property: value.key });
      owners.set(text, held);
    }
  }
  const spans: { start: number; end: number; value: string }[] = [];
  for (const value of owners.keys()) {
    for (const found of folded.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])${edge(value)}(?![\\p{L}\\p{N}_])`, 'gu'))) spans.push({ start: found.index, end: found.index + found[0].length, value });
  }
  spans.sort((first, second) => first.start - second.start || second.end - first.end);
  for (let index = 1; index < spans.length; index += 1) if ((spans[index]?.start ?? 0) < (spans[index - 1]?.end ?? 0)) return UNBOUND;
  // what is left once the whole values are taken out must hold no word of a sensitive value and no number written another way
  let rest = folded;
  for (const span of spans) rest = rest.slice(0, span.start) + ' '.repeat(span.end - span.start) + rest.slice(span.end);
  const joined = rest.replace(/(?<=\d)[\s,.\-/](?=\d)/gu, '');
  for (const value of owners.keys()) {
    for (const word of value.match(LETTERS) ?? []) {
      const digits = /^\d+$/u.test(word);
      if ((digits ? word.length < DIGITS_MIN : word.length < WORD_MIN)) continue;
      if (new RegExp(`(?<![\\p{L}\\p{N}_])${edge(word)}(?![\\p{L}\\p{N}_])`, 'u').test(rest)) return UNBOUND;
    }
    const digits = value.replace(/\D/gu, '');
    if (digits.length >= DIGITS_MIN && /^[\d\s,.\-/+()]+$/u.test(value) && joined.includes(digits)) return UNBOUND;
  }
  if (spans.length === 0) return { form: 'frozen' };
  const bound: BoundSpan[] = [];
  for (const span of spans) {
    const holders = owners.get(span.value) ?? [];
    const [only] = holders;
    if (only === undefined || holders.length !== 1 || !cited.includes(only.element)) return UNBOUND;
    bound.push({ start: span.start, end: span.end, element: only.element, property: only.property });
  }
  return { form: 'bound', spans: bound };
}
