import { useEffect, useState } from 'react';
import type { ApiFailure } from './api/client.js';
import { retryAfterMsOf } from './failure-words.js';

const TICK_MS = 1000;

/** The whole seconds the server asks the person to wait before the failed read is sent again, counting down; 0 when it asks for none or the wait is over. */
export function useRetryWait(failure: ApiFailure): number {
  const asked = Math.ceil((retryAfterMsOf(failure) ?? 0) / TICK_MS);
  const [held, setHeld] = useState({ failure, left: asked });
  const left = held.failure === failure ? held.left : asked;
  useEffect(() => {
    if (left <= 0) return undefined;
    const timer = setTimeout(() => setHeld({ failure, left: left - 1 }), TICK_MS);
    return () => clearTimeout(timer);
  }, [failure, left]);
  return left;
}
