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
