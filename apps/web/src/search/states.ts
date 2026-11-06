import type { SearchResult } from '@neburyx/contracts';
import { NO_RELATED_PROPERTIES, NO_SEARCH_PROPERTIES, NOTHING_SEARCHABLE_MASKED, RELATED_MASKED, EXACT_MASKED } from './copy.js';

type GroupState = 'hits' | 'empty' | 'failed' | 'not-searched';

const stateOf = (hits: number, searchable: boolean, failed: boolean): GroupState => (failed ? 'failed' : hits > 0 ? 'hits' : searchable ? 'empty' : 'not-searched');

export interface AnswerStates {
  /** True when a group was searched, no group has a hit and no group failed: the page says "No matching entities". */
  readonly noMatches: boolean;
  /** One line for each group that was not searched, unless the other group is shown; none names a value. */
  readonly reasons: readonly string[];
}

/**
 * What the page says about the two groups together. A group that was searched and is empty is not a group that was not searched: "No matching entities" needs a group that was searched,
 * and a group that was not searched says why, in words that name no value, unless the other group is on the page. A group with types left out names them under the summary instead.
 */
export function statesOf(result: SearchResult, mask: boolean): AnswerStates {
  const exact = stateOf(result.exact.length, result.searchable, result.failures.some((failure) => failure.group === 'exact'));
  const related = stateOf(result.related.hits.length, result.related.searchable, result.failures.some((failure) => failure.group === 'related'));
  const noMatches = result.failures.length === 0 && exact !== 'hits' && related !== 'hits' && (exact === 'empty' || related === 'empty');
  if (exact === 'not-searched' && related === 'not-searched') {
    if (mask) return { noMatches, reasons: [NOTHING_SEARCHABLE_MASKED] };
    return { noMatches, reasons: [...(result.disabledTypes.length === 0 ? [NO_SEARCH_PROPERTIES] : []), ...(result.related.disabledTypes.length === 0 ? [NO_RELATED_PROPERTIES] : [])] };
  }
  const reasons: string[] = [];
  if (exact === 'not-searched' && related !== 'hits' && result.disabledTypes.length === 0) reasons.push(mask ? EXACT_MASKED : NO_SEARCH_PROPERTIES);
  if (related === 'not-searched' && exact !== 'hits' && result.related.disabledTypes.length === 0) reasons.push(mask ? RELATED_MASKED : NO_RELATED_PROPERTIES);
  return { noMatches, reasons };
}
