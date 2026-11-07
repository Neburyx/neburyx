import { SOURCE_UNAVAILABLE_ENTRIES } from '@neburyx/contracts';
import type { ApiFailure } from './api/client.js';

/** Whether a retry can help: not for an unavailable source whose reason says so (a refused login, an index that is missing or failed, indexes that cannot be listed). */
export function canRetry(failure: ApiFailure): boolean {
  return !('traceId' in failure) || failure.code !== 'SOURCE_UNAVAILABLE' || failure.retryable;
}

/** What a failure is called: its code, or for an unavailable source the sentence of its reason (`unreachable` when it gives none). */
export function failureText(failure: ApiFailure): string {
  if (!('traceId' in failure) || failure.code !== 'SOURCE_UNAVAILABLE') return failure.code;
  return SOURCE_UNAVAILABLE_ENTRIES[failure.details?.reason ?? 'unreachable'].message;
}

export function FailureNotice({ failure }: { readonly failure: ApiFailure }) {
  return (
    <p role="alert">
      {failureText(failure)}
      {'traceId' in failure ? ` · trace ${failure.traceId}` : ''}
    </p>
  );
}
