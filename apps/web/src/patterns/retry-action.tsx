import { useEffect, useState } from 'react';
import { rateLimitedHeadline, rateLimitedRetry } from '../banner/copy.js';

const TICK_MS = 1000;

interface Props {
  readonly label: string;
  /** How long the server asks the person to wait; none for a Retry that can be pressed at once, with no number and no countdown. */
  readonly waitMs: number | undefined;
  readonly onRetry: () => void;
}

/**
 * A Retry that is held until the server's wait is over. For a rate limit the headline and the button count down together, as the banner's do, and the headline that says the person can retry now is the announcement.
 */
export function RetryAction({ label, waitMs, onRetry }: Props) {
  const [left, setLeft] = useState(Math.ceil((waitMs ?? 0) / TICK_MS));
  useEffect(() => {
    if (left <= 0) return undefined;
    const timer = setTimeout(() => setLeft((seconds) => Math.max(0, seconds - 1)), TICK_MS);
    return () => clearTimeout(timer);
  }, [left]);
  if (waitMs === undefined) {
    return (
      <button type="button" className="secondary" onClick={onRetry}>
        {label}
      </button>
    );
  }
  return (
    <>
      <p role={left === 0 ? 'status' : undefined}>{rateLimitedHeadline(left)}</p>
      <button type="button" className="secondary" disabled={left > 0} onClick={onRetry}>
        {rateLimitedRetry(left)}
      </button>
    </>
  );
}
