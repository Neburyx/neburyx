import { useEffect, useState } from 'react';
import type { PatternDefinition, PatternPreview } from '@neburyx/contracts';
import type { ApiClient } from '../../api/client.js';

/**
 * The definition in the server's words, asked once the check has answered valid for it, only for a definition that uses a fan, a time order or a closing: the chain of an ordinary pattern needs no words here. An answer to an older definition is never shown,
 * and a failure shows nothing (the preview screen asks again).
 */
export function usePatternWords(client: ApiClient, sourceId: string, mask: boolean, definition: PatternDefinition | undefined, validFor: string | undefined): PatternPreview | undefined {
  const [preview, setPreview] = useState<PatternPreview | undefined>(undefined);
  const key = definition === undefined ? undefined : JSON.stringify(definition);
  const valid = key !== undefined && validFor === key;
  useEffect(() => {
    setPreview(undefined);
    if (definition === undefined || !valid) return undefined;
    const controller = new AbortController();
    client
      .previewPattern({ sourceId, definition, ...(mask ? { mask: true } : {}) }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted && result.ok && result.value.status === 'ok') setPreview(result.value.preview);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [client, sourceId, mask, key, valid]);
  return preview;
}
