import type { AskRunResult, Count } from '@neburyx/contracts';
import { summarizeRun } from '../questions/run-summary.js';

const QUALITY_WORDS = { exact: 'exact', estimated: 'estimated', lowerBound: 'lower bound', unknown: 'count unknown' } as const;
const SIGNS = { exact: '', estimated: '~ ', lowerBound: '≥ ', unknown: '' } as const;

const figure = (value: number): string => value.toLocaleString('en-US');
const NOUNS = { match: ['match', 'matches'], row: ['row', 'rows'] } as const;
const plural = (value: number, noun: keyof typeof NOUNS): string => `${figure(value)} ${NOUNS[noun][value === 1 ? 0 : 1]}`;

/** The matches a result lists and the count of matches it carries, for the results whose count is of matches: the nodes a template run lists include the anchor and what it passed through, so they are never subtracted from its count; the matches of an expansion or a derived rule run are the neighbours or other ends it lists, without its anchor. */
function matchesOf(run: AskRunResult): { readonly shown: number; readonly count: Count } | undefined {
  switch (run.templateId) {
    case 'shared-attribute':
    case 'linked-entities':
      return run.result.status === 'heavy' ? undefined : { shown: run.result.matchIds.length, count: run.result.count };
    case 'saved-pattern':
      if (run.result.status === 'heavy') return undefined;
      if ('matchIds' in run.result) return { shown: run.result.matchIds.length, count: run.result.count };
      return 'matches' in run.result ? { shown: run.result.matches.length, count: run.result.count } : undefined;
    case 'derived-rule-run': {
      // each rule's nodes include the anchor, which is no match: the matches are the other ends each rule lists, counted by each rule's own count (the same end under two rules is two matches, in the shown and in the count alike)
      const { ref, results } = run.result;
      const isAnchor = (node: { readonly ref: { readonly sourceId: string; readonly entityType: string; readonly stableId: string } }): boolean => node.ref.sourceId === ref.sourceId && node.ref.entityType === ref.entityType && node.ref.stableId === ref.stableId;
      const shown = results.reduce((sum, entry) => sum + entry.nodes.filter((node) => !isAnchor(node)).length, 0);
      const values = results.map((entry) => entry.count.value);
      const qualities = results.map((entry) => entry.count.quality);
      const quality = qualities.includes('unknown') || values.includes(undefined) ? 'unknown' : qualities.includes('lowerBound') ? 'lowerBound' : qualities.includes('estimated') ? 'estimated' : 'exact';
      const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
      return { shown, count: { quality, ...(quality === 'unknown' ? {} : { value: total }), scope: 'derived:neighbors' } };
    }
    case 'expand': {
      // the nodes of an expansion include its anchor, which is no match: the matches are the neighbours it lists, and the count is exact only when no page has more
      const { ref, nodes, pages } = run.result;
      const shown = nodes.filter((node) => node.ref.sourceId !== ref.sourceId || node.ref.entityType !== ref.entityType || node.ref.stableId !== ref.stableId).length;
      return { shown, count: { quality: pages.some((page) => page.hasMore || page.nextCursor !== undefined || page.matchingTotal.quality !== 'exact') ? 'lowerBound' : 'exact', value: shown, scope: 'neighbors' } };
    }
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

/** A count as the copy rules write it: `169,756 (exact)`, `~ 169,756 (estimated)`, `≥ 1,000 · lower bound`, or `count unknown`. */
const countWords = (count: Count): string => {
  if (count.quality === 'unknown' || count.value === undefined) return QUALITY_WORDS.unknown;
  const figureText = `${SIGNS[count.quality]}${figure(count.value)}`;
  return count.quality === 'lowerBound' ? `${figureText} · ${QUALITY_WORDS.lowerBound}` : `${figureText} (${QUALITY_WORDS[count.quality]})`;
};

/**
 * The counts a degree read states, as the inspector shows them: the connected elements by the display name of their type, then in all, each with its quality. The figures are the source's, never summed here; `names` maps
 * an entity type to its display name, and a type it does not hold is written as the type itself.
 */
export function degreeCountsOf(run: AskRunResult, names: ReadonlyMap<string, string> = new Map()): string | undefined {
  if (run.templateId !== 'degree-preview') return undefined;
  const { total, byNeighborType } = run.result;
  const parts = [...byNeighborType.map((entry) => `${names.get(entry.entityType) ?? entry.entityType} ${countWords(entry.count)}`), `all types ${countWords(total)}`];
  return `connected elements by type: ${parts.join(' · ')}`;
}

/** The count a read's line is written with: the count the result carries (of matches, or the rows of a file query), or the number of elements it lists, which is exact; `value` is absent when the count is not known. */
export function countOf(run: AskRunResult): { readonly quality: Count['quality']; readonly value: number | undefined } {
  const matches = matchesOf(run);
  const count = matches?.count ?? (run.templateId === 'file-query' ? run.result.count : undefined);
  if (count === undefined) return { quality: 'exact', value: summarizeRun(run).rowCount };
  return count.quality === 'unknown' || count.value === undefined ? { quality: 'unknown', value: undefined } : { quality: count.quality, value: count.value };
}
