import type { ApiFailure } from '../../api/client.js';
import { canRetry } from '../../failure-notice.js';
import { formatNumber } from '../../workspace/scope-text.js';
import { failureView, type FailureView } from '../copy.js';

/** The words of the run screens: the frames' own where the frames give them, and proposed copy where they do not (listed with the frame differences). Every number comes from an answer. */
export const RUN_COPY = {
  previewTitle: 'Preview pattern',
  runningTitle: 'Running pattern',
  pausedTitle: 'Run paused',
  resultTitle: 'Pattern result',
  draft: 'Draft · not saved',
  mappingOk: 'The mapping can follow this pattern',
  inPlainWords: 'In plain words',
  start: 'Start',
  bounds: 'Bounds',
  readOnly: 'Read-only: nothing in the source is changed.',
  searchPlaceholder: 'Search by name or ID',
  savePattern: 'Save pattern…',
  saveChanges: 'Save changes…',
  saveAsNew: 'Save as new…',
  save: 'Save…',
  edit: 'Edit',
  run: 'Run pattern',
  runAgain: 'Run again',
  loadingPreview: 'Reading the pattern in words…',
  previewFailed: 'The preview could not be made.',
  countsAlways: 'Counts are always labelled Exact, Lower bound or Estimated. When a count is unknown, no number is shown.',
  cancelled: 'Run cancelled. Nothing was added to the graph. Your draft is kept.',
  cancelRun: 'Cancel run',
  cancelNote: 'Cancelling stops the run and keeps your draft.',
  startingFrom: 'Starting from',
  slow: 'Large sources can take longer.',
  noCounts: 'No counts until the run finishes',
  noCountsLine: 'Matches appear together with an exact count or a labelled lower bound. Nothing is changed in the source.',
  runningStatus: 'Running',
  estimated: 'Estimated',
  lowerBound: 'Lower bound',
  exact: 'Exact',
  heavyNumberUnknown: 'The number is not known; it could be higher.',
  heavyStopped: 'The run stopped before reading matches, to protect the source. Nothing was changed.',
  choose: 'What would you like to do?',
  refine: 'Refine filters',
  refineLine: 'Add conditions or a date window, then run again. No matches are shown yet.',
  cancel: 'Cancel',
  editPattern: 'Edit pattern',
  matches: 'Matches',
  match: 'Match',
  evidence: 'Evidence',
  noEvidence: 'No evidence reference came with this match.',
  addToGraph: 'Add to graph',
  onGraph: 'On the graph',
  path: 'Path',
  gap: 'an entity without an ID',
  hiddenEntity: 'an entity',
  unusableRelationship: 'a relationship',
  previous: 'Previous',
  next: 'Next',
  readingPage: 'Reading the next page…',
  chosen: 'Chosen',
  chooseOne: 'Choose one',
  none: 'No match found',
  runFailed: 'The run could not be made.',
  tryAgain: 'Try again',
  pickOne: 'You must pick one to run.',
  draftName: 'Draft',
} as const;

export const typesMatching = (typeName: string, text: string): string => `${typeName}s matching “${text}”`;
export const typesOnCanvas = (typeName: string): string => `${typeName}s on the canvas`;
export const startFrom = (typeName: string): string => `Start from a ${typeName}`;
export const startHelper = (typeName: string): string => `Prefilled when a ${typeName} is selected or open on the canvas. Otherwise search by name or ID. You must pick one to run.`;
export const boundPage = (limit: number): string => `Up to ${formatNumber(limit)} matches per page.`;
export const boundCount = (cap: number): string => `A count above ${formatNumber(cap)} is shown as “at least ${formatNumber(cap)}” and labelled lower bound.`;
export const startingFromLine = (name: string, typeName: string, id: string | undefined): string => [name, typeName, id].filter((part) => part !== undefined && part !== '').join(' · ');
export const elapsedText = (seconds: number): string => `${seconds} s elapsed. ${RUN_COPY.slow}`;
export const pausedHeadline = (count: number): string => `Estimated ≥ ${formatNumber(count)} matches`;
export const pausedLine = (name: string): string => `This pattern may match a lot from ${name}. ${RUN_COPY.heavyNumberUnknown}`;
export const continueLine = (limit: number, count: number): string => `Shows the first ${formatNumber(limit)} matches. The count stays a lower bound: “at least ${formatNumber(count)}”.`;
export const searchSummary = (shown: number, total: string | undefined): string => `${formatNumber(shown)} ${shown === 1 ? 'match' : 'matches'} on this page${total === undefined ? '' : ` of ${total}`}. Type more to narrow.`;
export const noMatchText = (name: string): string => `Nothing in this source follows this pattern from ${name}. Try fewer conditions or a longer date window.`;
export const runFromAnother = (typeName: string): string => `Run from another ${typeName}`;
export const countedBy = (time: string): string => `Counted by the source. Run at ${time} UTC.`;
export const estimatedBy = (time: string): string => `Estimated by the source. Run at ${time} UTC.`;
export const noCountBy = (time: string): string => `The source gave no count. Run at ${time} UTC.`;
export const showingFirst = (returned: number): string => `Showing the first ${formatNumber(returned)}. The real number may be higher; it is not known.`;
export const showingPage = (from: number, to: number): string => `Showing ${formatNumber(from)} to ${formatNumber(to)}. The real number may be higher; it is not known.`;
export const showingHeading = (from: number, to: number, of: string | undefined): string => `${RUN_COPY.matches} · showing ${formatNumber(from)} to ${formatNumber(to)}${of === undefined ? '' : ` of ${of}`}`;
export const matchesWord = (count: number): string => `${formatNumber(count)} ${count === 1 ? 'match' : 'matches'}`;
export const addAll = (count: number): string => `Add all ${formatNumber(count)} to graph`;
export const addThese = (count: number): string => `Add these ${formatNumber(count)} to graph`;
export const utcTime = (at: Date): string => at.toISOString().slice(11, 16);

/** The sentence of a failed pattern run, in the table's words, with Try again only where a retry can help: the server says so, or for the client's own failures when the network or the page failed. */
export function runFailureView(failure: ApiFailure, sourceName: string): FailureView {
  const view = failureView(failure, sourceName);
  const retryable = canRetry(failure) && ('retryable' in failure ? failure.retryable : failure.code === 'NETWORK_UNAVAILABLE' || failure.code === 'UNEXPECTED_FAILURE');
  const trace = 'traceId' in failure && (failure.code === 'CONFLICT' || failure.code === 'ACCESS_DENIED' || failure.code === 'INTERNAL_ERROR') ? ` Trace ${failure.traceId}.` : '';
  const { action, ...rest } = view;
  return { ...rest, text: `${view.text}${trace}`, ...(action !== undefined && retryable ? { action } : {}) };
}
