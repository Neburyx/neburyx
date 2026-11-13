import type { ApiFailure } from '../../api/client.js';
import { GRAPH_UNCHANGED } from '../../search/copy.js';
import { canRetry } from '../../failure-notice.js';
import { RETRY } from '../../banner/copy.js';
import { failureView, maxHopsOf, type FailureView } from '../copy.js';

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

export const stepLimitText = (limit: number): string => `The source allows at most ${limit} steps.`;

/** The sentence of a failed pattern run, with Retry only where a retry can help: the source states are the panel's own texts. */
export function runFailureView(failure: ApiFailure, sourceName: string): FailureView {
  const retryable = canRetry(failure) && ('retryable' in failure ? failure.retryable : failure.code === 'NETWORK_UNAVAILABLE' || failure.code === 'UNEXPECTED_FAILURE');
  const plain = (text: string): FailureView => ({ text, detail: GRAPH_UNCHANGED, ...(retryable ? { action: RETRY } : {}) });
  switch (failure.code) {
    case 'QUERY_BUDGET_EXCEEDED': {
      const hops = maxHopsOf(failure);
      return { text: hops === undefined ? RUN_COPY.runFailed : stepLimitText(hops), detail: GRAPH_UNCHANGED };
    }
    case 'INVALID_REQUEST':
      return plain('The server refused this pattern.');
    case 'NOT_FOUND':
      return plain('The starting entity or the source was not found.');
    case 'SCHEMA_MISMATCH':
      return plain('The answer was not in the form expected.');
    case 'CONFLICT':
    case 'ACCESS_DENIED':
    case 'INTERNAL_ERROR': {
      const trace = 'traceId' in failure ? ` Trace ${failure.traceId}.` : '';
      return plain(`${RUN_COPY.runFailed}${trace}`);
    }
    default: {
      const view = failureView(failure, sourceName);
      return view.action === undefined || retryable ? view : { text: view.text, detail: view.detail };
    }
  }
}
