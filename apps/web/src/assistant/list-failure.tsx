import type { ApiFailure } from '../api/client.js';
import { FailureNotice, offersRetry } from '../failure-notice.js';
import { tryAgainIn } from '../failure-words.js';
import { useRetryWait } from '../retry-wait.js';
import { CHAT_LIST_COPY } from './chat-list/copy.js';

/** A failure of the list in the product's words, with Try again when trying again can help. */
export function ListFailure({ failure, onRetry }: { readonly failure: ApiFailure; readonly onRetry?: (() => void) | undefined }) {
  const left = useRetryWait(failure);
  return (
    <div role="group" className="chat-list-failure">
      <FailureNotice failure={failure} />
      {onRetry !== undefined && offersRetry(failure) ? (
        <button type="button" className="chat-list-link" disabled={left > 0} {...(left > 0 ? {} : { 'aria-label': CHAT_LIST_COPY.retryLabel })} onClick={onRetry}>
          {left > 0 ? tryAgainIn(left) : CHAT_LIST_COPY.retry}
        </button>
      ) : null}
    </div>
  );
}
