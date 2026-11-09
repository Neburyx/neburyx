import type { ApiFailure } from '../api/client.js';
import { FailureNotice } from '../failure-notice.js';
import { READING_EVIDENCE, TRY_AGAIN } from './copy.js';

/** A failure can be tried again unless the answer itself was refused as malformed or the API says a retry cannot help. */
export function canTryAgain(failure: ApiFailure): boolean {
  if ('traceId' in failure) return failure.retryable;
  return failure.code !== 'SCHEMA_MISMATCH';
}

interface Props {
  readonly failure: ApiFailure;
  readonly reading: boolean;
  readonly reload: () => void;
}

/** What a failed read shows: the product's failure text, the way to try again when it can help, and while that try is on its way the earlier text stays. It is the content of the panel only and clears nothing outside it. */
export function EvidenceFailure({ failure, reading, reload }: Props) {
  return (
    <div className="evidence-failure">
      <FailureNotice failure={failure} />
      {reading ? <p role="status">{READING_EVIDENCE}</p> : null}
      {canTryAgain(failure) ? (
        <button type="button" className="evidence-retry" disabled={reading} onClick={reload}>
          {TRY_AGAIN}
        </button>
      ) : null}
    </div>
  );
}
