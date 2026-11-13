import type { ApiFailure } from '../../api/client.js';
import { canRetry } from '../../failure-notice.js';
import { failureView, type FailureView } from '../copy.js';

/** The words of the run section of the builder. The heavy, cancelled, busy, rate-limited and unavailable texts are the panel's (ui-spec §13); the rest is proposed copy, listed with the frame differences. */
export const RUN_COPY = {
  preview: 'Preview',
  bounds: 'Bounds',
  startsFrom: 'Starts from',
  run: 'Run pattern',
  needComplete: 'Complete the pattern first.',
  notValid: 'The pattern is not valid.',
  checking: 'Checking the pattern…',
  checkFailed: 'The check could not be made.',
  waitPreview: 'Wait for the preview.',
  previewFailed: 'The preview could not be made.',
  loadingPreview: 'Reading the pattern in words…',
  chooseStart: 'Choose where to start.',
  gap: 'an entity without an ID',
  unusableRelationship: 'a relationship',
  path: 'Path',
  match: 'Match',
  runFailed: 'The run could not be made.',
} as const;

/** The sentence of a failed pattern run, in the table's words, with Try again only where a retry can help: the server says so, or for the client's own failures when the network or the page failed. */
export function runFailureView(failure: ApiFailure, sourceName: string): FailureView {
  const view = failureView(failure, sourceName);
  const retryable = canRetry(failure) && ('retryable' in failure ? failure.retryable : failure.code === 'NETWORK_UNAVAILABLE' || failure.code === 'UNEXPECTED_FAILURE');
  const trace = 'traceId' in failure && (failure.code === 'CONFLICT' || failure.code === 'ACCESS_DENIED' || failure.code === 'INTERNAL_ERROR') ? ` Trace ${failure.traceId}.` : '';
  const { action, ...rest } = view;
  return { ...rest, text: `${view.text}${trace}`, ...(action !== undefined && retryable ? { action } : {}) };
}
