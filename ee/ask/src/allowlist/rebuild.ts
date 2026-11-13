import { COMMON_WORDS } from './common-words.js';
import { isCalendarDate } from './dates.js';
import { vocabularyForms } from './forms.js';
import { phraseCoverage, type PhraseToken } from './phrases.js';

export interface ResolvedSpan {
  readonly start: number;
  readonly end: number;
  readonly placeholder: string;
}

export interface RebuildInput {
  readonly text: string;
  readonly spans: readonly ResolvedSpan[];
  readonly vocabulary: readonly string[];
}

export interface BlockedToken {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export type RebuildResult = { readonly kind: 'rebuilt'; readonly text: string } | { readonly kind: 'blocked'; readonly tokens: readonly BlockedToken[] };

export class AllowlistInputError extends Error {}

const MARKS = '.,?!;:';
const WHITESPACE = new Set([' ', '\t', '\r', '\n']);
const PLACEHOLDER_SHAPE = /^‹[A-Za-z0-9_-]+#[1-9][0-9]*›$/;
const DIGITS = /^[0-9]+$/;
const MAX_COUNT_DIGITS = 3;
const WORD_SHAPE = /^[A-Za-z]+([-_][A-Za-z]+)*$/;

interface Unit {
  readonly start: number;
  readonly end: number;
  readonly char: string;
  readonly placeholder?: string;
}

interface Candidate {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly marks: string;
  readonly rebuilt: string;
  readonly kind: 'marks' | 'placeholder' | 'count' | 'longNumber' | 'date' | 'word' | 'other';
  readonly allowed: boolean;
}

function checkedSpans(text: string, spans: readonly ResolvedSpan[]): readonly ResolvedSpan[] {
  const sorted = [...spans].sort((left, right) => left.start - right.start);
  let previousEnd = 0;
  for (const span of sorted) {
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end > text.length || span.start >= span.end) {
      throw new AllowlistInputError('a resolved span lies outside the text or is empty');
    }
    if (span.start < previousEnd) throw new AllowlistInputError('resolved spans overlap');
    if (!PLACEHOLDER_SHAPE.test(span.placeholder)) throw new AllowlistInputError('a resolved span has a placeholder of the wrong form');
    previousEnd = span.end;
  }
  return sorted;
}

function unitsOf(text: string, spans: readonly ResolvedSpan[]): Unit[] {
  const units: Unit[] = [];
  let index = 0;
  for (const span of spans) {
    for (; index < span.start; index += 1) units.push({ start: index, end: index + 1, char: text.charAt(index) });
    units.push({ start: span.start, end: span.end, char: '', placeholder: span.placeholder });
    index = span.end;
  }
  for (; index < text.length; index += 1) units.push({ start: index, end: index + 1, char: text.charAt(index) });
  return units;
}

function tokenRuns(units: readonly Unit[]): Unit[][] {
  const runs: Unit[][] = [];
  let current: Unit[] = [];
  for (const unit of units) {
    if (unit.placeholder === undefined && WHITESPACE.has(unit.char)) {
      if (current.length > 0) runs.push(current);
      current = [];
    } else {
      current.push(unit);
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

function candidateOf(run: readonly Unit[], text: string, isWordAllowed: (word: string) => boolean): Candidate {
  let coreEnd = run.length;
  while (coreEnd > 0 && run[coreEnd - 1]?.placeholder === undefined && MARKS.includes(run[coreEnd - 1]?.char ?? '')) coreEnd -= 1;
  const core = run.slice(0, coreEnd);
  const marks = run.slice(coreEnd).map((unit) => unit.char).join('');
  const first = core[0];
  const last = core[core.length - 1];
  if (first === undefined || last === undefined) return { start: run[0]?.start ?? 0, end: run[run.length - 1]?.end ?? 0, text: marks, marks: '', rebuilt: marks, kind: 'marks', allowed: true };
  const typed = text.slice(first.start, last.end);
  const base = { start: first.start, end: last.end, text: typed, marks };
  const placeholder = first.placeholder;
  if (core.length === 1 && placeholder !== undefined) return { ...base, rebuilt: `${placeholder}${marks}`, kind: 'placeholder', allowed: true };
  const rebuilt = `${typed}${marks}`;
  if (core.some((unit) => unit.placeholder !== undefined)) return { ...base, rebuilt, kind: 'other', allowed: false };
  if (isCalendarDate(typed)) return { ...base, rebuilt, kind: 'date', allowed: true };
  if (DIGITS.test(typed)) return typed.length <= MAX_COUNT_DIGITS ? { ...base, rebuilt, kind: 'count', allowed: true } : { ...base, rebuilt, kind: 'longNumber', allowed: false };
  if (WORD_SHAPE.test(typed)) return { ...base, rebuilt, kind: 'word', allowed: typed.split(/[-_]/).every(isWordAllowed) };
  return { ...base, rebuilt, kind: 'other', allowed: false };
}

function phraseCoverageOf(candidates: readonly Candidate[]): ReadonlySet<number> {
  const tokens: PhraseToken[] = candidates.map((candidate) => ({
    lower: candidate.kind === 'word' ? candidate.text.toLowerCase() : '',
    isCount: candidate.kind === 'count' || candidate.kind === 'longNumber',
    hasMarks: candidate.marks !== '',
  }));
  return phraseCoverage(tokens);
}

function withoutNumberRuns(candidates: readonly Candidate[], covered: ReadonlySet<number>): Candidate[] {
  const blocked = new Set<number>();
  let run: number[] = [];
  const flush = (): void => {
    if (run.length >= 2) for (const index of run) blocked.add(index);
    run = [];
  };
  candidates.forEach((candidate, index) => {
    if (candidate.kind === 'count' && !covered.has(index)) run.push(index);
    else if (candidate.kind !== 'marks') flush();
  });
  flush();
  return candidates.map((candidate, index) => (blocked.has(index) ? { ...candidate, allowed: false } : candidate));
}

/**
 * Rebuilds the question from allowed tokens only. A token is allowed when it is a resolved placeholder on its own, a number of at most
 * three digits that is not next to another number, a calendar date, part of a time-window phrase, or a word that is a common word or a
 * form of a vocabulary word. Everything else blocks, with its position in the typed text (UTF-16 units, end exclusive). The marks
 * `. , ? ! ; :` after a token are kept. Case is kept; matching ignores it.
 */
export function rebuildPlannerText(input: RebuildInput): RebuildResult {
  return rebuildWithWords(input, COMMON_WORDS);
}

/** The rebuild with a list of common words given by the caller. Only tests and the question-word check use it; the package entry does not export it. */
export function rebuildWithWords(input: RebuildInput, commonWords: Iterable<string>): RebuildResult {
  const spans = checkedSpans(input.text, input.spans);
  const runs = tokenRuns(unitsOf(input.text, spans));
  if (runs.length === 0) throw new AllowlistInputError('the question is empty');
  const forms = vocabularyForms(input.vocabulary);
  const common = new Set([...commonWords].map((word) => word.toLowerCase()));
  const isWordAllowed = (word: string): boolean => common.has(word.toLowerCase()) || forms.has(word.toLowerCase());
  const candidates = runs.map((run) => candidateOf(run, input.text, isWordAllowed));
  const covered = phraseCoverageOf(candidates);
  const phrased = candidates.map((candidate, index) => (covered.has(index) && candidate.kind !== 'longNumber' ? { ...candidate, allowed: true } : candidate));
  const final = withoutNumberRuns(phrased, covered);
  const blocked = final.filter((candidate) => !candidate.allowed);
  if (blocked.length > 0) return { kind: 'blocked', tokens: blocked.map(({ text, start, end }) => ({ text, start, end })) };
  return { kind: 'rebuilt', text: final.map((candidate) => candidate.rebuilt).join(' ') };
}
