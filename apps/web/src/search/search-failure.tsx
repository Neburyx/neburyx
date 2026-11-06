import type { ApiFailure } from '../api/client.js';
import { FailureNotice } from '../failure-notice.js';
import { GRAPH_UNCHANGED, RETRY, timedOutText, unknownSourceText } from './copy.js';

function timeoutOf(failure: ApiFailure): number | undefined {
  return 'details' in failure ? failure.details?.timeoutMs : undefined;
}

/** What a failed search says: that it timed out and for how long, or the error's code and trace ID; that nothing was changed; and **Retry**. A source the person may not read is answered as one that is not configured, so the page says that and nothing more. */
export function SearchFailure({ failure, sourceId, onRetry }: { readonly failure: ApiFailure; readonly sourceId: string; readonly onRetry: () => void }) {
  if (failure.code === 'NOT_FOUND') return <p role="alert">{unknownSourceText(sourceId)}</p>;
  return (
    <div className="search-failure">
      {failure.code === 'QUERY_TIMEOUT' ? (
        <div role="alert">
          <p>{timedOutText(timeoutOf(failure))}</p>
          <p>{GRAPH_UNCHANGED}</p>
        </div>
      ) : (
        <>
          <FailureNotice failure={failure} />
          <p>{GRAPH_UNCHANGED}</p>
        </>
      )}
      <button type="button" onClick={onRetry}>
        {RETRY}
      </button>
    </div>
  );
}
