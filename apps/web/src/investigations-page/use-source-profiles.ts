import { useEffect, useRef, useState } from 'react';
import type { SourceProfile } from '@neburyx/contracts';
import type { ApiClient } from '../api/client.js';

/** The profile of each source of the rows, read once each, for the display name and the icon of an entity type; a source whose profile cannot be read has none and its rows show what is stored. */
export function useSourceProfiles(client: ApiClient, sourceIds: readonly string[]): ReadonlyMap<string, SourceProfile> {
  const [profiles, setProfiles] = useState<ReadonlyMap<string, SourceProfile>>(new Map());
  const asked = useRef(new Set<string>());
  const abort = useRef(new AbortController());
  const wanted = [...new Set(sourceIds)].sort().join('\u0000');

  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    asked.current.clear();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    for (const sourceId of wanted === '' ? [] : wanted.split('\u0000')) {
      if (asked.current.has(sourceId)) continue;
      asked.current.add(sourceId);
      void client.getProfile(sourceId, abort.current.signal).then((result) => {
        if (!abort.current.signal.aborted && result.ok) setProfiles((held) => new Map(held).set(sourceId, result.value));
      });
    }
  }, [client, wanted]);

  return profiles;
}
