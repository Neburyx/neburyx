import type { ApiFailure } from '../api/client.js';
import { FailureNotice, offersRetry } from '../failure-notice.js';
import { CHAT_LIST_COPY } from './chat-list/copy.js';

/** A failure of the list in the product's words, with Try again when trying again can help. */
export function ListFailure({ failure, onRetry }: { readonly failure: ApiFailure; readonly onRetry?: (() => void) | undefined }) {
  return (
    <div role="group" className="chat-list-failure">
      <FailureNotice failure={failure} />
      {onRetry !== undefined && offersRetry(failure) ? (
        <button type="button" className="chat-list-link" aria-label={CHAT_LIST_COPY.retryLabel} onClick={onRetry}>
          {CHAT_LIST_COPY.retry}
        </button>
      ) : null}
    </div>
  );
}
