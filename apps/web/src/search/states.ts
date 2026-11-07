import type { Facets, SearchResult } from '@neburyx/contracts';
import { EXACT_MASKED, FILTERS_COPY, NO_EVIDENCE_PROPERTIES, NO_RELATED_PROPERTIES, NO_SEARCH_PROPERTIES, NOTHING_SEARCHABLE_MASKED, RELATED_MASKED } from './copy.js';

type Group = 'exact' | 'related' | 'evidence';
type GroupState = 'hits' | 'empty' | 'failed' | 'not-searched' | 'hidden';

const stateOf = (hits: number, searchable: boolean, failed: boolean, hidden: boolean): GroupState => (hidden ? 'hidden' : failed ? 'failed' : hits > 0 ? 'hits' : searchable ? 'empty' : 'not-searched');

/** What the page says when no group has a row to show. */
export type EmptyMessage = 'none' | 'no-matches' | 'unshown' | 'no-result-for-selection';

export interface AnswerStates {
  /** True when a group was searched, no group has a hit and no group failed, and no count says the source holds more: the page says "No matching entities". */
  readonly noMatches: boolean;
  /** What the page says when no group has a hit, none failed and at least one was searched (see `statesOf`). */
  readonly message: EmptyMessage;
  /** One line for each group that was not searched, unless another group has hits; none names a value. */
  readonly reasons: readonly string[];
  /** The groups the selection leaves out, which the page says it hides. */
  readonly hidden: readonly Group[];
}

/** True when a count of the facets says the source holds a match: the total, an entity type or a match mode with a number above zero; a count that was not read says nothing. */
function matchesFound(facets: Facets | undefined): boolean {
  if (facets === undefined || !facets.searchable) return false;
  const counts = [facets.total, ...facets.entityType.map((entry) => entry.count), ...facets.matchMode.map((entry) => entry.count)];
  return counts.some((count) => count.quality !== 'unknown' && count.value > 0);
}

/**
 * What the page says about the three groups together, in this order of precedence. A group the selection leaves out is hidden, and is not searched. A group that failed puts no empty message on
 * the page. With no group searched the page gives the reasons (nothing configured, masked, nothing for the selected types). With a group searched and every searched group empty and none failed, the
 * page says "No matching entities" unless a count of the facets says the source holds matches: then "Matches were found in the source but none could be shown" with nothing selected, and "No result for this
 * selection" with a selection. A group with hits is never shown beside a message.
 */
export function statesOf(result: SearchResult, mask: boolean): AnswerStates {
  const failedIn = (group: Group) => result.failures.some((failure) => failure.group === group);
  const modes = result.filters?.matchModes ?? [];
  const types = result.filters?.entityTypes ?? [];
  const hiddenIn = (group: Group) => modes.length > 0 && !modes.includes(group);
  // a hit with no usable stable ID is listed in its group, so a group that holds only such hits has hits
  const exact = stateOf(result.exact.length + (result.exactUnreferenced?.length ?? 0), result.searchable, failedIn('exact'), hiddenIn('exact'));
  const related = stateOf(result.related.hits.length + (result.related.unreferenced?.length ?? 0), result.related.searchable, failedIn('related'), hiddenIn('related'));
  const evidence = stateOf(result.evidence.hits.length, result.evidence.searchable, failedIn('evidence'), hiddenIn('evidence'));
  const states = [exact, related, evidence];
  const hidden = (['exact', 'related', 'evidence'] as const).filter(hiddenIn);
  if (states.includes('hits')) return { noMatches: false, message: 'none', reasons: [], hidden };
  const anyFailed = states.includes('failed');
  const narrowed = types.length > 0 || modes.length > 0;
  const message: EmptyMessage = anyFailed || !states.includes('empty') ? 'none' : matchesFound(result.facets) ? (narrowed ? 'no-result-for-selection' : 'unshown') : 'no-matches';
  const unsearched = (state: GroupState): boolean => state === 'not-searched';
  if (mask && unsearched(exact) && unsearched(related) && unsearched(evidence)) return { noMatches: message === 'no-matches', message, reasons: [NOTHING_SEARCHABLE_MASKED], hidden };
  // a group with a count of its own in the facets has targets without the selection: it has nothing to search for the selected types
  // counts that were not read cannot say; with a type chosen the selection is then the reason the page gives
  const notRead = result.facets?.searchable === true && result.facets.total.quality === 'unknown';
  const hasTargets = (mode: 'exact' | 'related'): boolean => notRead || (result.facets?.searchable === true && result.facets.matchMode.some((entry) => entry.mode === mode));
  const forTypes = types.length > 0;
  const reasons: string[] = [];
  if (unsearched(exact) && result.disabledTypes.length === 0) reasons.push(forTypes && hasTargets('exact') ? FILTERS_COPY.nothingForTypes : mask ? EXACT_MASKED : NO_SEARCH_PROPERTIES);
  if (unsearched(related) && result.related.disabledTypes.length === 0) reasons.push(forTypes && hasTargets('related') ? FILTERS_COPY.nothingForTypes : mask ? RELATED_MASKED : NO_RELATED_PROPERTIES);
  if (unsearched(evidence) && result.evidence.disabledRelationshipTypes.length === 0) reasons.push(NO_EVIDENCE_PROPERTIES);
  return { noMatches: message === 'no-matches', message, reasons: [...new Set(reasons)], hidden };
}
