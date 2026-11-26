import type { ReactNode } from 'react';
import type { ApiFailure } from './api/client.js';
import { FailureNotice, offersRetry } from './failure-notice.js';
import { tryAgainIn } from './failure-words.js';
import { useRetryWait } from './retry-wait.js';

interface Props {
  readonly failure: ApiFailure;
  /** Words written before the sentence, inside the same alert. */
  readonly prefix?: string;
  /** The read to repeat, with the accessible name that says what is read again; the button shows only where a retry helps. */
  readonly retry: { readonly name: string; readonly run: () => void };
  /** The button under the sentence, or beside it across the width of the page. */
  readonly layout?: 'stacked' | 'row';
  readonly children?: ReactNode;
}

/** The shared failure notice in a box of its own with its Try again, for a place that has no failure block with a control. */
export function FailureBox({ failure, prefix, retry, layout = 'stacked', children }: Props) {
  return (
    <div className="failure-box" data-layout={layout}>
      <FailureNotice failure={failure} {...(prefix === undefined ? {} : { prefix })} />
      {offersRetry(failure) ? <RetryButton failure={failure} name={retry.name} run={retry.run} compact={layout === 'stacked'} /> : null}
      {children}
    </div>
  );
}

/** Try again for a failed read, disabled and counting down while the server asks the person to wait. */
export function RetryButton({ failure, name, run, compact = true }: { readonly failure: ApiFailure; readonly name: string; readonly run: () => void; readonly compact?: boolean }) {
  const left = useRetryWait(failure);
  return (
    <button type="button" className={compact ? 'secondary failure-retry' : 'secondary'} disabled={left > 0} {...(left > 0 ? {} : { 'aria-label': name })} onClick={run}>
      {tryAgainIn(left)}
    </button>
  );
}
