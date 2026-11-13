import type { ApiFailure } from '../api/client.js';
import type { Count, TemplateRunNotice } from '@neburyx/contracts';
import { degreeCountText } from '../workspace/degree-text.js';
import type { AddedOutcome } from './add-to-graph.js';
import { BUSY_TEXT, RATE_LIMITED_TEXT, REFINE_FILTERS, RETRY, TIMED_OUT_TEXT, UNAVAILABLE_TEXT } from '../banner/copy.js';
import { GRAPH_UNCHANGED } from '../search/copy.js';
import { failureWords, TRY_AGAIN } from './failure-words.js';
import type { PatternProblem, PatternProblemCode } from '@neburyx/contracts';
import type { Direction } from './builder/model.js';

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

export { maxHopsOf, maxPageOf } from './failure-words.js';

export interface FailureView {
  readonly text: string;
  /** The explanation line under the text: the one of ui-spec §13 for a source state, the graph-unchanged line otherwise. */
  readonly detail: string;
  /** The recovery action, when the state has one. */
  readonly action?: string;
  /** For a rate limit: how long the server asks the person to wait, in milliseconds. */
  readonly waitMs?: number;
}

/** The text of a failed call, in words: a sentence from the table of `failure-words.ts` and, for a source state, the explanation of ui-spec §13 under it; the action's label is Try again. */
export function failureView(failure: ApiFailure, source: string): FailureView {
  const words = failureWords(failure, source);
  const action = words.action === 'try-again' ? TRY_AGAIN : undefined;
  const detail = failure.code === 'SOURCE_BUSY' ? BUSY_TEXT : failure.code === 'RATE_LIMITED' ? RATE_LIMITED_TEXT : failure.code === 'SOURCE_UNAVAILABLE' ? UNAVAILABLE_TEXT : failure.code === 'QUERY_TIMEOUT' ? TIMED_OUT_TEXT : PATTERNS_COPY.graphUnchanged;
  return { text: words.text, detail, ...(action === undefined ? {} : { action }), ...(words.waitMs === undefined ? {} : { waitMs: words.waitMs }) };
}

export const ARROW: Readonly<Record<Direction, string>> = { out: '→', in: '←', both: '↔' };

const PROBLEM_TEXT: Readonly<Record<PatternProblemCode, string>> = {
  'unknown-key': 'This part of the pattern has something the mapping does not know.',
  'wrong-type': 'This part of the pattern is not in the form the mapping expects.',
  missing: 'Something is missing here.',
  'too-many': 'There are more here than a pattern may have.',
  'too-few': 'There are fewer here than a pattern needs.',
  'too-many-hops': 'This pattern has more steps than the source allows.',
  'bad-value': 'This choice is not allowed.',
  'bad-shape': 'This choice does not fit with the others.',
  'unknown-entity-type': 'This type is not in the mapping.',
  'unknown-relationship-type': 'This relationship type is not in the mapping.',
  'relationship-does-not-join': 'This relationship type does not join the types of this step in this direction.',
  'unknown-property': 'This property is not in the mapping.',
  'not-filterable': 'This property cannot be used in a condition.',
  'personal-data-masked': 'This property holds personal data and cannot be used while masking is on.',
};

export const problemText = (problem: PatternProblem): string => PROBLEM_TEXT[problem.code];

/** The line under the panel's heading in the list: which source, and that the list is read-only. */
export const listSubtitle = (source: string): string => `Source: ${source} · read-only`;
/** The line under the panel's heading in the editor: that what is being made is not saved. */
export const EDITOR_SUBTITLE = 'Draft · not saved';

/** The words of the panel's shell that the panel and the editor both use. */
export const SHELL_COPY = {
  newPattern: 'New pattern',
  restartedByMask: 'Masking changed, so the pattern was started again.',
} as const;
