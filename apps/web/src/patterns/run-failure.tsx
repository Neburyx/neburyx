import { useEffect, useState } from 'react';
import { rateLimitedHeadline, rateLimitedRetry } from '../banner/copy.js';
import type { FailureView } from './copy.js';

const TICK_MS = 1000;

interface Props {
  readonly failure: FailureView;
  /** The cap a refused run was over, named after the headline. */
  readonly budgetCap: number | undefined;
  /** Whether a Retry can help and there is a run to repeat. */
  readonly canRetry: boolean;
  readonly onRetry: () => void;
}

/**
 * A failed run: the headline, then its explanation line, then the recovery action. For a rate limit the headline and the button count down together from the server's wait, as the banner's do; the headline that says the person
 * can retry now is the announcement. With no wait given there is no number and no countdown, and Retry is enabled.
 */
export function RunFailure({ failure, budgetCap, canRetry, onRetry }: Props) {
  const [left, setLeft] = useState(Math.ceil((failure.waitMs ?? 0) / TICK_MS));
  useEffect(() => {
    if (left <= 0) return undefined;
    const timer = setTimeout(() => setLeft((seconds) => Math.max(0, seconds - 1)), TICK_MS);
    return () => clearTimeout(timer);
  }, [left]);
  const counting = failure.waitMs !== undefined;
  const headline = counting ? rateLimitedHeadline(left) : budgetCap === undefined ? failure.text : `${failure.text} The source allows at most ${budgetCap}; the field is set to it.`;
  return (
    <div className="patterns-state" role="alert">
      <p role={counting && left === 0 ? 'status' : undefined}>{headline}</p>
      <p>{failure.detail}</p>
      {failure.action === undefined || !canRetry ? null : (
        <button type="button" className="secondary" disabled={counting && left > 0} onClick={onRetry}>
          {counting ? rateLimitedRetry(left) : failure.action}
        </button>
      )}
    </div>
  );
}
