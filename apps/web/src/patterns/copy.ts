import type { ApiFailure } from '../api/client.js';
import type { Count, TemplateRunNotice } from '@neburyx/contracts';
import { degreeCountText } from '../workspace/degree-text.js';
import type { AddedOutcome } from './add-to-graph.js';
import { BUSY_TEXT, busyHeadline, rateLimitedHeadline, RATE_LIMITED_TEXT, REFINE_FILTERS, RETRY, TIMED_OUT_TEXT, timedOutHeadline, UNAVAILABLE_TEXT, unavailableHeadline } from '../banner/copy.js';
import { GRAPH_UNCHANGED } from '../search/copy.js';
import { failureText } from '../failure-notice.js';

export const PATTERNS_COPY = {
  title: 'Patterns',
  close: 'Close Patterns',
  intro: 'Approved ways to explore. No query language needed.',
  list: 'Patterns',
  run: 'Run pattern',
  cancel: 'Cancel',
  runAgain: 'Run again',
  retry: RETRY,
  /** Proposed copy (the frame and the ui-spec give none). */
  noPatterns: 'This source has no patterns.',
  noMatches: 'No matches found.',
  cancelled: 'Cancelled. No new matches shown.',
  earlierResult: 'This is the result of the earlier run. The last run gave no result.',
  loading: 'Loading patterns…',
  refine: REFINE_FILTERS,
  startNone: 'Choose an entity',
  searchLabel: 'Search the source',
  searchNone: 'Nothing found.',
  searchFailed: 'The search failed.',
  graphUnchanged: GRAPH_UNCHANGED,
  result: 'Result',
  matchHeading: 'Match',
  reachedHeading: 'Reached',
  evidence: 'Evidence',
  /** Proposed copy (frame 09 draws no control for adding a result). */
  addToGraph: 'Add to graph',
  onCanvas: 'On canvas',
  runInProgress: 'A run is in progress',
} as const;

/** Says what is missing in the words of the form's own field label, so no article is chosen from a type name. */
export const startHint = (fieldLabel: string): string => `Choose the ${fieldLabel.toLowerCase()} to run this pattern.`;

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** What adding a result did, in exact facts of the client; the run's own count is named, with its label, only when it says more may exist. */
export function addedText(outcome: AddedOutcome, count: Count): string {
  const added = `Added ${plural(outcome.entities, 'entity', 'entities')} and ${plural(outcome.relationships, 'relationship', 'relationships')}.`;
  const heldParts = [outcome.heldEntities === 0 ? '' : plural(outcome.heldEntities, 'entity', 'entities'), outcome.heldRelationships === 0 ? '' : plural(outcome.heldRelationships, 'relationship', 'relationships')].filter((part) => part !== '');
  const held = heldParts.length === 0 ? '' : ` ${heldParts.join(' and ')} already loaded.`;
  const more = count.quality === 'lowerBound' ? ` The run’s count is ${degreeCountText(count)}: more matches may exist and were not loaded.` : count.quality === 'unknown' ? ' The run gave no count: more matches may exist and were not loaded.' : '';
  return `${added}${held}${more}`;
}

export const selectTypeHint = (typeName: string): string => `Select ${typeName === '' ? 'an entity' : `a ${typeName}`} to start.`;
export const timeoutLabel = (timeoutMs: number): string => `${Math.round(timeoutMs / 100) / 10} s timeout`;

/** One sentence for a notice of a run; the codes that carry names say how many. */
export function noticeText(notice: TemplateRunNotice): string {
  switch (notice.code) {
    case 'stopListSkipped':
      return 'An attribute on the source’s stop list was skipped.';
    case 'noStopList':
      return 'The source has no stop list for this pattern.';
    case 'undatedExcluded':
      return 'Relationships without a usable date are outside the window.';
    case 'readBounded':
      return 'The read was cut, so the count is a lower bound.';
    case 'evidenceCut':
      return 'Not every shared attribute is listed.';
    case 'windowNotApplied':
      return `The window did not apply to ${notice.relationshipTypes.length} relationship ${notice.relationshipTypes.length === 1 ? 'type' : 'types'}.`;
    case 'supernodesSkipped':
      return `${notice.entities.length} ${notice.entities.length === 1 ? 'supernode was' : 'supernodes were'} not traversed.`;
    default: {
      const unreachable: never = notice;
      return unreachable;
    }
  }
}

const retryAfterMs = (failure: ApiFailure): number | undefined => ('details' in failure && failure.details !== undefined && 'retryAfterMs' in failure.details && typeof failure.details.retryAfterMs === 'number' ? failure.details.retryAfterMs : undefined);
const timeoutOf = (failure: ApiFailure): number | undefined => ('details' in failure && failure.details !== undefined && 'timeoutMs' in failure.details && typeof failure.details.timeoutMs === 'number' ? failure.details.timeoutMs : undefined);
export const maxHopsOf = (failure: ApiFailure): number | undefined => ('details' in failure && failure.details !== undefined && 'maxHops' in failure.details && typeof failure.details.maxHops === 'number' ? failure.details.maxHops : undefined);
export const maxPageOf = (failure: ApiFailure): number | undefined => ('details' in failure && failure.details !== undefined && 'maxPage' in failure.details && typeof failure.details.maxPage === 'number' ? failure.details.maxPage : undefined);

export interface FailureView {
  readonly text: string;
  /** The explanation line under the text: the one of ui-spec §13 for a source state, the graph-unchanged line otherwise. */
  readonly detail: string;
  /** The recovery action, when the state has one. */
  readonly action?: string;
  /** For a rate limit: how long the server asks the person to wait, in milliseconds. */
  readonly waitMs?: number;
}

/** The text of a failed call, in the words of ui-spec §13 for a source state; any other code is named by its failure text. */
export function failureView(failure: ApiFailure, source: string): FailureView {
  switch (failure.code) {
    case 'SOURCE_BUSY':
      return { text: busyHeadline(source), detail: BUSY_TEXT, action: RETRY };
    case 'RATE_LIMITED': {
      const wait = retryAfterMs(failure);
      return { text: rateLimitedHeadline(Math.ceil((wait ?? 0) / 1000)), detail: RATE_LIMITED_TEXT, action: RETRY, ...(wait === undefined ? {} : { waitMs: wait }) };
    }
    case 'SOURCE_UNAVAILABLE':
      return { text: unavailableHeadline(source), detail: UNAVAILABLE_TEXT, action: RETRY };
    case 'QUERY_TIMEOUT': {
      const limit = timeoutOf(failure);
      return { text: limit === undefined ? `${source} did not answer in time.` : timedOutHeadline(source, limit), detail: TIMED_OUT_TEXT, action: RETRY };
    }
    default:
      return { text: failureText(failure), detail: PATTERNS_COPY.graphUnchanged };
  }
}

