import { MAX_SEARCH_TEXT_LENGTH, ASK_MAX_RESOLUTIONS, type AskEntityLookup, type AskEntityMatches, type AskEntitySearch, type AskResolution, type Count, type ElementRef } from '@neburyx/contracts';
import { MIN_SPAN_LENGTH, candidateSpans, overlaps, wordsOf, type Word } from './spans.js';

/** The most searches and lookups one question makes (mention searches and the lookups of the investigator's picks together); each search also makes the search service's own bounded facet read. */
export const MAX_RESOLUTION_READS = 12;
/** The most choices a clarification offers. */
export const MAX_CLARIFICATION_CHOICES = 10;

export type PlaceholderEntry = { readonly kind: 'entity'; readonly ref: ElementRef } | { readonly kind: 'value'; readonly text: string };

export const RESOLUTION_REFUSALS = ['typed-placeholder', 'too-many', 'out-of-range', 'overlap', 'other-source', 'unconfirmed-reference', 'value-too-long'] as const;
export type ResolutionRefusal = (typeof RESOLUTION_REFUSALS)[number];

export interface Clarification {
  readonly start: number;
  readonly end: number;
  readonly choices: readonly ElementRef[];
  readonly count: Count;
  /** How many hits have no reference, so cannot be picked. */
  readonly unreferenced: number;
}

/** A placeholder in the resolved text, as offsets in UTF-16 code units of that text. */
export interface PlaceholderSpan {
  readonly start: number;
  readonly end: number;
  readonly placeholder: string;
}

export type ResolutionOutcome =
  | { readonly status: 'resolved'; readonly text: string; readonly spans: readonly PlaceholderSpan[]; readonly placeholders: ReadonlyMap<string, PlaceholderEntry>; readonly capReached: boolean }
  | { readonly status: 'clarification'; readonly clarification: Clarification }
  | { readonly status: 'refused'; readonly reason: ResolutionRefusal };

export interface ResolveInput {
  readonly message: string;
  readonly resolutions: readonly AskResolution[];
  readonly sourceId: string;
  readonly search: AskEntitySearch;
  readonly lookup: AskEntityLookup;
  /** Lower-case words that are never mentions: a span that starts or ends with one is not searched, so a span made only of them never is. */
  readonly skipWords?: ReadonlySet<string>;
  readonly signal: AbortSignal;
}

interface Replacement extends Word {
  readonly entry: PlaceholderEntry;
}

interface Ambiguity extends Word {
  readonly matches: AskEntityMatches;
}

const codePointCount = (text: string): number => Array.from(text).length;

/** An entity type is part of its placeholder only when it is one plain token that cannot be taken for a value placeholder. */
const PLAIN_TYPE = /^[A-Za-z0-9_-]+$/;
const FALLBACK_KIND = 'entity';
const kindOf = (entityType: string): string => (PLAIN_TYPE.test(entityType) && entityType !== 'value' ? entityType : FALLBACK_KIND);

function refusalOf(input: ResolveInput): ResolutionRefusal | undefined {
  const { message, resolutions, sourceId } = input;
  if (message.includes('‹') || message.includes('›')) return 'typed-placeholder';
  if (resolutions.length > ASK_MAX_RESOLUTIONS) return 'too-many';
  const words = wordsOf(message);
  const isWordStart = (offset: number): boolean => words.some((word) => word.start === offset);
  const isWordEnd = (offset: number): boolean => words.some((word) => word.end === offset);
  const ordered = [...resolutions].sort((left, right) => left.start - right.start);
  for (const [index, resolution] of ordered.entries()) {
    if (resolution.end > message.length || resolution.end <= resolution.start || !isWordStart(resolution.start) || !isWordEnd(resolution.end)) return 'out-of-range';
    const previous = ordered[index - 1];
    if (previous !== undefined && overlaps(previous, resolution)) return 'overlap';
    if ('ref' in resolution && resolution.ref.sourceId !== sourceId) return 'other-source';
    if ('value' in resolution && codePointCount(message.slice(resolution.start, resolution.end)) > MAX_SEARCH_TEXT_LENGTH) return 'value-too-long';
  }
  return undefined;
}

function isSkipped(message: string, span: Word, skipWords: ReadonlySet<string> | undefined): boolean {
  const text = message.slice(span.start, span.end);
  if (codePointCount(text) < MIN_SPAN_LENGTH || codePointCount(text) > MAX_SEARCH_TEXT_LENGTH) return true;
  if (skipWords === undefined) return false;
  const typed = wordsOf(text).map((word) => text.slice(word.start, word.end).toLowerCase());
  const first = typed[0];
  const last = typed[typed.length - 1];
  return first === undefined || last === undefined || skipWords.has(first) || skipWords.has(last);
}

function placeholdersOf(message: string, replacements: readonly Replacement[]): { text: string; spans: PlaceholderSpan[]; placeholders: Map<string, PlaceholderEntry> } {
  const spans: PlaceholderSpan[] = [];
  const placeholders = new Map<string, PlaceholderEntry>();
  const names = new Map<string, string>();
  const counters = new Map<string, number>();
  let text = '';
  let cursor = 0;
  for (const replacement of [...replacements].sort((left, right) => left.start - right.start)) {
    const { entry } = replacement;
    const kind = entry.kind === 'entity' ? kindOf(entry.ref.entityType) : 'value';
    const identity = entry.kind === 'entity' ? JSON.stringify([entry.ref.entityType, entry.ref.stableId]) : JSON.stringify(['value', entry.text]);
    let name = names.get(identity);
    if (name === undefined) {
      const next = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, next);
      name = `‹${kind}#${next}›`;
      names.set(identity, name);
      placeholders.set(name, entry);
    }
    text += message.slice(cursor, replacement.start);
    spans.push({ start: text.length, end: text.length + name.length, placeholder: name });
    text += name;
    cursor = replacement.end;
  }
  return { text: text + message.slice(cursor), spans, placeholders };
}

/**
 * Finds the mentions in a typed message and replaces them with placeholders. The investigator's resolutions are applied first, each entity pick confirmed by a lookup; the rest of the message is searched for mentions, span by span, within one budget of reads. A mention that fits several
 * entities is never resolved without a choice: the outcome is a clarification for the leftmost one. A search that fails fails the resolution.
 */
export async function resolveMentions(input: ResolveInput): Promise<ResolutionOutcome> {
  const refusal = refusalOf(input);
  if (refusal !== undefined) return { status: 'refused', reason: refusal };
  const { message, resolutions, sourceId, search, lookup, signal, skipWords } = input;
  const replacements: Replacement[] = [];
  let reads = 0;
  for (const resolution of resolutions) {
    if ('ref' in resolution) {
      signal.throwIfAborted();
      reads += 1;
      if (!(await lookup(resolution.ref, signal))) return { status: 'refused', reason: 'unconfirmed-reference' };
      replacements.push({ start: resolution.start, end: resolution.end, entry: { kind: 'entity', ref: resolution.ref } });
    } else {
      replacements.push({ start: resolution.start, end: resolution.end, entry: { kind: 'value', text: message.slice(resolution.start, resolution.end) } });
    }
  }
  const claimed: Word[] = replacements.map(({ start, end }) => ({ start, end }));
  const ambiguities: Ambiguity[] = [];
  let capReached = false;
  for (const span of candidateSpans(message, claimed)) {
    if (claimed.some((range) => overlaps(span, range)) || isSkipped(message, span, skipWords)) continue;
    if (reads >= MAX_RESOLUTION_READS) {
      capReached = true;
      break;
    }
    signal.throwIfAborted();
    reads += 1;
    const matches = await search({ text: message.slice(span.start, span.end) }, signal);
    if (matches.refs.some((ref) => ref.sourceId !== sourceId)) throw new Error('a mention search answered with an entity of another source');
    const [only] = matches.refs;
    if (only !== undefined && matches.refs.length === 1 && matches.unreferenced === 0) {
      replacements.push({ ...span, entry: { kind: 'entity', ref: only } });
      claimed.push(span);
    } else if (matches.refs.length + matches.unreferenced > 0) {
      ambiguities.push({ ...span, matches });
      claimed.push(span);
    }
  }
  const [leftmost] = [...ambiguities].sort((left, right) => left.start - right.start);
  if (leftmost !== undefined) {
    const { refs, unreferenced, count } = leftmost.matches;
    return { status: 'clarification', clarification: { start: leftmost.start, end: leftmost.end, choices: refs.slice(0, MAX_CLARIFICATION_CHOICES), count, unreferenced } };
  }
  return { status: 'resolved', ...placeholdersOf(message, replacements), capReached };
}
