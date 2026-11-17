import { useEffect, useState } from 'react';
import type { PatternDefinition, PatternPreview } from '@neburyx/contracts';
import type { ApiClient } from '../../api/client.js';

/**
 * The definition in the server's words, asked once the check has answered valid for it, only for a definition that uses a fan, a time order or a closing: the chain of an ordinary pattern needs no words here. The answer is kept with the definition it
 * belongs to and returned only for that one, so a changed definition never shows the words of the one before. A failure shows nothing (the preview screen asks again).
 */
export function usePatternWords(client: ApiClient, sourceId: string, mask: boolean, definition: PatternDefinition | undefined, validFor: string | undefined): PatternPreview | undefined {
  const [held, setHeld] = useState<{ readonly key: string; readonly preview: PatternPreview } | undefined>(undefined);
  const key = definition === undefined ? undefined : JSON.stringify(definition);
  const valid = key !== undefined && validFor === key;
  useEffect(() => {
    if (definition === undefined || !valid || key === undefined) return undefined;
    const controller = new AbortController();
    client
      .previewPattern({ sourceId, definition, ...(mask ? { mask: true } : {}) }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted && result.ok && result.value.status === 'ok') setHeld({ key, preview: result.value.preview });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [client, sourceId, mask, key, valid]);
  return held !== undefined && held.key === key && valid ? held.preview : undefined;
}
