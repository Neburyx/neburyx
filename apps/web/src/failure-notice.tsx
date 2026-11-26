import { SOURCE_UNAVAILABLE_ENTRIES, SOURCE_UNAVAILABLE_REASONS } from '@neburyx/contracts';
import type { ApiFailure } from './api/client.js';
import { failureWords, type FailureCode } from './failure-words.js';

/** What the sentences call the source when the place that shows them has no name for it. */
const UNNAMED_SOURCE = 'The source';

/** Whether sending the same request again can help: not for an unavailable source whose reason says so (a refused login, an index that is missing or failed, indexes that cannot be listed). */
export function canRetry(failure: ApiFailure): boolean {
  return !('traceId' in failure) || failure.code !== 'SOURCE_UNAVAILABLE' || failure.retryable;
}

/** Whether a failed read offers Try again: its sentence says to try again, and a retry can help. */
export function offersRetry(failure: ApiFailure): boolean {
  return canRetry(failure) && failureWords(failure, UNNAMED_SOURCE).action === 'try-again';
}

/** The sentence of a code that comes without the rest of its failure, as a group of an answer gives it. */
export function codeText(code: FailureCode, source: string = UNNAMED_SOURCE): string {
  return code === 'SOURCE_UNAVAILABLE' ? SOURCE_UNAVAILABLE_ENTRIES.unreachable.message : failureWords({ code }, source).text;
}

/** A failure in one sentence with no code in it; an unavailable source of the server says the sentence of its reason (`unreachable` when it gives none). */
export function failureText(failure: ApiFailure, source: string = UNNAMED_SOURCE): string {
  if (!('traceId' in failure) || failure.code !== 'SOURCE_UNAVAILABLE') return failureWords(failure, source).text;
  const reason = SOURCE_UNAVAILABLE_REASONS.find((candidate) => candidate === failure.details?.reason);
  return reason === undefined ? codeText(failure.code) : SOURCE_UNAVAILABLE_ENTRIES[reason].message;
}

/** `headline` is a line over the sentence, said with it as one alert. */
export function FailureNotice({ failure, prefix = '', headline }: { readonly failure: ApiFailure; readonly prefix?: string; readonly headline?: string }) {
  return (
    <p role="alert" className="failure-notice">
      {headline === undefined ? null : (
        <>
          <span className="failure-headline">{headline}</span>{' '}
        </>
      )}
      {prefix}
      {failureText(failure)}
      {'traceId' in failure ? (
        <>
          {' · trace '}
          <span className="failure-trace">{failure.traceId}</span>
        </>
      ) : null}
    </p>
  );
}
