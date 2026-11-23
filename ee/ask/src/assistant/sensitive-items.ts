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

/** The shortest word of a sensitive value that counts as a part of it. An item the classifier cannot decide is `unbound`, and a false `unbound` only withholds text under the mask, so the threshold errs that way. */
const WORD_MIN = 2;
/** The fewest digits of a number that count as a value when it is written as a whole word. */
const DIGITS_MIN = 4;
/** The fewest letters and digits of a word of a value that count as written when its letters and digits are found in the text with any separators between them; a whole value counts at any length, and its compatible forms (full-width digits) are folded. A false match only withholds an item under the mask. */
const SKELETON_MIN = 2;

/** A text as its letters and digits alone: no accent, no case, no separator, and the compatible forms of a character (full-width digits) folded to the plain ones. What a person could read as the same value however it is written. */
const skeletonOf = (text: string): string => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
/** The same fold with the separators kept, for whole words. */
const plainOf = (text: string): string => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** What the classifier reads of a turn's assembled text: the values sent, and every element key the lines name (the completeness of the provenance is judged from all of them, never from a list the caller chooses). */
export type Provenance = Pick<ClassifyContext, 'sentValues' | 'sent' | 'typeOf'>;
export const provenanceOf = (assembled: { readonly keys: ReadonlyMap<string, { readonly kind: string; readonly ref: unknown }>; readonly sentValues?: ReadonlyMap<string, readonly SentValue[]> | undefined }): Provenance => ({
  sentValues: assembled.sentValues,
  sent: [...assembled.keys.keys()],
  typeOf: (key) => {
    const held = assembled.keys.get(key);
    return held?.kind === 'entity' ? (held.ref as { entityType: string }).entityType : undefined;
  },
});

export function classifyItem(text: string, cited: readonly string[], context: ClassifyContext): Classified {
  const { sentValues, sensitiveKeys } = context;
  if (sentValues === undefined || sensitiveKeys === undefined) return UNBOUND;
  if (context.sent.some((key) => !sentValues.has(key)) || cited.some((key) => !sentValues.has(key))) return UNBOUND;
  const written = text.normalize('NFC');
  const folded = written.toLowerCase();
  // a case fold that moves the offsets would put a span in the wrong place: the item is not bound
  if (folded.length !== written.length) return UNBOUND;
  const owners = new Map<string, { element: string; property: string }[]>();
  const originals = new Map<string, Set<string>>();
  for (const [element, values] of sentValues) {
    const type = context.typeOf(element);
    const keys = type === undefined ? undefined : sensitiveKeys.get(type);
    if (keys === undefined) continue;
    for (const value of values) {
      const exact = value.text.normalize('NFC').trim();
      const text = exact.toLowerCase();
      if (!keys.includes(value.key) || value.masked || text === '') continue;
      originals.set(text, (originals.get(text) ?? new Set<string>()).add(exact));
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
  // what is left must hold no word of a sensitive value, and the value in no other shape: its letters and digits alone, without accents, case or separators
  const left = plainOf(rest);
  const leftSkeleton = skeletonOf(rest);
  for (const value of owners.keys()) {
    for (const word of plainOf(value).match(LETTERS) ?? []) {
      const digits = /^\d+$/u.test(word);
      if (digits ? word.length < DIGITS_MIN : word.length < WORD_MIN) continue;
      if (new RegExp(`(?<![\\p{L}\\p{N}_])${edge(word)}(?![\\p{L}\\p{N}_])`, 'u').test(left)) return UNBOUND;
    }
    // the value, and each of its words, in any shape (hyphenated, spaced, with other separators): a piece that cannot be told from ordinary text is withheld rather than shown
    const whole = skeletonOf(value);
    const pieces = (plainOf(value).match(LETTERS) ?? []).map(skeletonOf);
    if ((whole !== '' && leftSkeleton.includes(whole)) || pieces.some((piece) => piece.length >= SKELETON_MIN && leftSkeleton.includes(piece))) return UNBOUND;
  }
  if (spans.length === 0) return { form: 'frozen' };
  const bound: BoundSpan[] = [];
  for (const span of spans) {
    const holders = owners.get(span.value) ?? [];
    const [only] = holders;
    // a value is bound only where the text writes it exactly as it was sent: a match that differs in case alone may be an ordinary word
    if (only === undefined || holders.length !== 1 || !cited.includes(only.element) || originals.get(span.value)?.has(written.slice(span.start, span.end)) !== true) return UNBOUND;
    bound.push({ start: span.start, end: span.end, element: only.element, property: only.property });
  }
  return { form: 'bound', spans: bound };
}
