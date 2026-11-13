import { useCallback, useEffect, useRef, useState } from 'react';
import type { PatternDefinition, PatternProblem } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../../api/client.js';
import { UNEXPECTED } from '../../api/use-request.js';

/** The same wait the search's type-ahead makes before it asks (`TYPEAHEAD_DEBOUNCE_MS`). */
export const CHECK_DEBOUNCE_MS = 250;

export type CheckState =
  | { readonly kind: 'none' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'valid' }
  | { readonly kind: 'invalid'; readonly problems: readonly PatternProblem[] }
  | { readonly kind: 'failed'; readonly failure: ApiFailure };

export interface Check {
  readonly state: CheckState;
  /** The definition (as its JSON) that the answer `valid` belongs to; none while the definition has changed since or no valid answer is held. */
  readonly validFor: string | undefined;
  /** When the source last answered about the definition shown (the client's clock, as the time it was told), or nothing while the answer is not in. */
  readonly checkedAt: Date | undefined;
  readonly retry: () => void;
}

/**
 * Asks the server whether the definition is acceptable, once the person has stopped changing it for the debounce. A result belongs to the definition it was asked for: a change clears it at once, an incomplete definition has none,
 * and an answer to an older ask, or to a source that has since changed, is never shown. The route reads no source.
 */
export function usePatternCheck(client: ApiClient, sourceId: string, mask: boolean, definition: PatternDefinition | undefined): Check {
  const [state, setState] = useState<CheckState>({ kind: 'none' });
  const [validFor, setValidFor] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [checkedAt, setCheckedAt] = useState<Date | undefined>(undefined);
  const retrying = useRef(false);
  const key = definition === undefined ? undefined : JSON.stringify(definition);

  useEffect(() => {
    setValidFor(undefined);
    setCheckedAt(undefined);
    if (definition === undefined) {
      setState({ kind: 'none' });
      return undefined;
    }
    setState({ kind: 'checking' });
    const delay = retrying.current ? 0 : CHECK_DEBOUNCE_MS;
    retrying.current = false;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        const send = async (): Promise<void> => {
          let result: Awaited<ReturnType<ApiClient['validatePattern']>>;
          try {
            result = await client.validatePattern({ sourceId, definition, ...(mask ? { mask: true } : {}) }, controller.signal);
          } catch {
            result = UNEXPECTED;
          }
          if (controller.signal.aborted) return;
          if (!result.ok) setState(result.failure.code === 'ABORTED' ? { kind: 'none' } : { kind: 'failed', failure: result.failure });
          else {
            setState(result.value.status === 'ok' ? { kind: 'valid' } : { kind: 'invalid', problems: result.value.problems });
            setCheckedAt(new Date());
            if (result.value.status === 'ok') setValidFor(key);
          }
        };
        void send();
      },
      delay,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, sourceId, mask, key, attempt]);

  const retry = useCallback((): void => {
    retrying.current = true;
    setAttempt((count) => count + 1);
  }, []);
  return { state, validFor, checkedAt, retry };
}
