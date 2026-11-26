import type { ApiFailure } from '../../api/client.js';
import { RetryButton } from '../../failure-box.js';
import { RETRY_NAMES } from '../../failure-copy.js';
import { FailureNotice, offersRetry } from '../../failure-notice.js';

/** The failure of a reread over saved patterns that stay: the sentence, with Try again beside it on a page and at its right in a panel. */
export function RereadFailure({ failure, place, retry }: { readonly failure: ApiFailure; readonly place: 'page' | 'panel'; readonly retry: () => void }) {
  return (
    <div className="reread-failure" data-place={place}>
      <FailureNotice failure={failure} />
      {offersRetry(failure) ? <RetryButton failure={failure} name={RETRY_NAMES.savedPatterns} run={retry} /> : null}
    </div>
  );
}
