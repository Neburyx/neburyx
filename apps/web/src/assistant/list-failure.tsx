import type { ApiFailure } from '../api/client.js';
import { failureWords } from '../patterns/failure-words.js';
import { CHAT_LIST_COPY } from './chat-list/copy.js';

/** A failure of the list in the product's words, with Try again when trying again can help. */
export function ListFailure({ failure, onRetry }: { readonly failure: ApiFailure; readonly onRetry?: (() => void) | undefined }) {
  const words = failureWords(failure, '');
  return (
    <div role="group" className="chat-list-failure">
      <p role="alert">
        {words.text}
        {'traceId' in failure ? ` · trace ${failure.traceId}` : ''}
      </p>
      {onRetry !== undefined && words.action === 'try-again' ? (
        <button type="button" className="chat-list-link" aria-label={CHAT_LIST_COPY.retryLabel} onClick={onRetry}>
          {CHAT_LIST_COPY.retry}
        </button>
      ) : null}
    </div>
  );
}
