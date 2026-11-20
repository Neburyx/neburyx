import type { AskRunResult, Count } from '@neburyx/contracts';
import { summarizeRun } from '../questions/run-summary.js';

const QUALITY_WORDS = { exact: 'exact', estimated: 'estimated', lowerBound: 'lower bound', unknown: 'count unknown' } as const;
const SIGNS = { exact: '', estimated: '~ ', lowerBound: '≥ ', unknown: '' } as const;

const figure = (value: number): string => value.toLocaleString('en-US');
const NOUNS = { match: ['match', 'matches'], row: ['row', 'rows'] } as const;
const plural = (value: number, noun: keyof typeof NOUNS): string => `${figure(value)} ${NOUNS[noun][value === 1 ? 0 : 1]}`;

/** The matches a result lists and the count of matches it carries, for the results whose count is of matches: the nodes it lists include the anchor and what it passed through, so they are never subtracted from it. */
function matchesOf(run: AskRunResult): { readonly shown: number; readonly count: Count } | undefined {
  switch (run.templateId) {
    case 'shared-attribute':
    case 'linked-entities':
      return run.result.status === 'heavy' ? undefined : { shown: run.result.matchIds.length, count: run.result.count };
    case 'saved-pattern':
      if (run.result.status === 'heavy') return undefined;
      if ('matchIds' in run.result) return { shown: run.result.matchIds.length, count: run.result.count };
      return 'matches' in run.result ? { shown: run.result.matches.length, count: run.result.count } : undefined;
    default:
      return undefined;
  }
}

/**
 * How much of a result is shown and how much is not yet retrieved, with the quality of the count, each in the unit of its own count: matches for a template or pattern run, rows for a file query (whose count is the
 * rows it returned, so nothing is "not yet retrieved" from it unless the count is a lower bound), and the listed elements for a result with no count of its own.
 */
export function coverageOf(run: AskRunResult): string {
  const matches = matchesOf(run);
  if (matches !== undefined) {
    const { shown, count } = matches;
    if (count.quality === 'unknown' || count.value === undefined) return `${plural(shown, 'match')} shown · ${QUALITY_WORDS.unknown}`;
    const rest = Math.max(count.value - shown, 0);
    const retrieved = rest === 0 ? '' : ` · ${SIGNS[count.quality]}${figure(rest)} not yet retrieved`;
    return `${plural(shown, 'match')} shown${retrieved} · ${QUALITY_WORDS[count.quality]}`;
  }
  if (run.templateId === 'file-query') {
    const { count } = run.result;
    if (count.quality === 'unknown' || count.value === undefined) return `rows ${QUALITY_WORDS.unknown}`;
    return `${SIGNS[count.quality]}${plural(count.value, 'row')} · ${QUALITY_WORDS[count.quality]}`;
  }
  const { rowCount, partial } = summarizeRun(run);
  return `${figure(rowCount)} shown${partial ? ' · partial' : ''}`;
}

/** What a read's line says of a count that is not exact: the phrase as the line writes it with the figure it carries (a figure not yet retrieved, or the rows of a file query), or `unknown` when the line says the count is not known. Nothing for an exact count. */
export function inexactCountOf(run: AskRunResult): { readonly phrase: string; readonly value: string } | 'unknown' | undefined {
  const matches = matchesOf(run);
  const count = matches?.count ?? (run.templateId === 'file-query' ? run.result.count : undefined);
  if (count === undefined) return undefined;
  if (count.quality === 'unknown' || count.value === undefined) return 'unknown';
  if (count.quality === 'exact') return undefined;
  const figureValue = matches === undefined ? count.value : Math.max(count.value - matches.shown, 0);
  return figureValue === 0 && matches !== undefined ? undefined : { phrase: `${SIGNS[count.quality]}${figure(figureValue)}`, value: String(figureValue) };
}

/** The count a read's line is written with: the count the result carries (of matches, or the rows of a file query), or the number of elements it lists, which is exact; `value` is absent when the count is not known. */
export function countOf(run: AskRunResult): { readonly quality: Count['quality']; readonly value: number | undefined } {
  const matches = matchesOf(run);
  const count = matches?.count ?? (run.templateId === 'file-query' ? run.result.count : undefined);
  if (count === undefined) return { quality: 'exact', value: summarizeRun(run).rowCount };
  return count.quality === 'unknown' || count.value === undefined ? { quality: 'unknown', value: undefined } : { quality: count.quality, value: count.value };
}
