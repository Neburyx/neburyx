import type { SearchResult } from '@neburyx/contracts';
import { EXACT_MASKED, NO_EVIDENCE_PROPERTIES, NO_RELATED_PROPERTIES, NO_SEARCH_PROPERTIES, NOTHING_SEARCHABLE_MASKED, RELATED_MASKED } from './copy.js';

type GroupState = 'hits' | 'empty' | 'failed' | 'not-searched';

const stateOf = (hits: number, searchable: boolean, failed: boolean): GroupState => (failed ? 'failed' : hits > 0 ? 'hits' : searchable ? 'empty' : 'not-searched');

export interface AnswerStates {
  /** True when a group was searched, no group has a hit and no group failed: the page says "No matching entities". */
  readonly noMatches: boolean;
  /** One line for each group that was not searched, unless another group has hits; none names a value. */
  readonly reasons: readonly string[];
}

/**
 * What the page says about the three groups together. A group that was searched and is empty is not a group that was not searched: "No matching entities" needs a group that was searched,
 * and a group that was not searched says why, in words that name no value, unless another group is on the page. A group with types left out names them under the summary instead.
 */
export function statesOf(result: SearchResult, mask: boolean): AnswerStates {
  const failedIn = (group: 'exact' | 'related' | 'evidence') => result.failures.some((failure) => failure.group === group);
  const exact = stateOf(result.exact.length, result.searchable, failedIn('exact'));
  const related = stateOf(result.related.hits.length, result.related.searchable, failedIn('related'));
  const evidence = stateOf(result.evidence.hits.length, result.evidence.searchable, failedIn('evidence'));
  const states = [exact, related, evidence];
  const noMatches = result.failures.length === 0 && !states.includes('hits') && states.includes('empty');
  if (states.includes('hits')) return { noMatches, reasons: [] };
  const unsearched = (state: GroupState): boolean => state === 'not-searched';
  if (mask && unsearched(exact) && unsearched(related) && unsearched(evidence)) return { noMatches, reasons: [NOTHING_SEARCHABLE_MASKED] };
  const reasons: string[] = [];
  if (unsearched(exact) && result.disabledTypes.length === 0) reasons.push(mask ? EXACT_MASKED : NO_SEARCH_PROPERTIES);
  if (unsearched(related) && result.related.disabledTypes.length === 0) reasons.push(mask ? RELATED_MASKED : NO_RELATED_PROPERTIES);
  if (unsearched(evidence) && result.evidence.disabledRelationshipTypes.length === 0) reasons.push(NO_EVIDENCE_PROPERTIES);
  return { noMatches, reasons };
}
