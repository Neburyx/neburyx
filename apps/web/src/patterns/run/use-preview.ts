import { useCallback, useEffect, useState } from 'react';
import type { PatternDefinition, PatternPreview, PatternProblem } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../../api/client.js';
import { UNEXPECTED } from '../../api/use-request.js';

export type PreviewState =
  | { readonly kind: 'none' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly preview: PatternPreview }
  | { readonly kind: 'invalid'; readonly problems: readonly PatternProblem[] }
  | { readonly kind: 'failed'; readonly failure: ApiFailure };

export interface Preview {
  readonly state: PreviewState;
  readonly retry: () => void;
}

/**
 * Asks the server for the definition in plain words once the check has answered valid, so that an invalid definition is answered once, by the check. A preview belongs to the definition it was asked for: a change clears it at
 * once, a definition that is not valid has none, and an answer to an older ask, or to a source that has since changed, is never shown. The route reads no source, and the client writes no phrase of its own.
 */
export function usePatternPreview(client: ApiClient, sourceId: string, mask: boolean, definition: PatternDefinition | undefined, validFor: string | undefined): Preview {
  const [state, setState] = useState<PreviewState>({ kind: 'none' });
  const [attempt, setAttempt] = useState(0);
  const key = definition === undefined ? undefined : JSON.stringify(definition);
  const valid = key !== undefined && validFor === key;

  useEffect(() => {
    if (definition === undefined || !valid) {
      setState({ kind: 'none' });
      return undefined;
    }
    setState({ kind: 'loading' });
    const controller = new AbortController();
    const send = async (): Promise<void> => {
      let result: Awaited<ReturnType<ApiClient['previewPattern']>>;
      try {
        result = await client.previewPattern({ sourceId, definition, ...(mask ? { mask: true } : {}) }, controller.signal);
      } catch {
        result = UNEXPECTED;
      }
      if (controller.signal.aborted) return;
      if (!result.ok) setState(result.failure.code === 'ABORTED' ? { kind: 'none' } : { kind: 'failed', failure: result.failure });
      else setState(result.value.status === 'ok' ? { kind: 'ready', preview: result.value.preview } : { kind: 'invalid', problems: result.value.problems });
    };
    void send();
    return () => controller.abort();
  }, [client, sourceId, mask, key, valid, attempt]);

  const retry = useCallback((): void => setAttempt((count) => count + 1), []);
  return { state, retry };
}
