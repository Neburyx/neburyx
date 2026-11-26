import { useEffect, useRef, useState } from 'react';
import type { InvestigationListItem, SourceProfile } from '@neburyx/contracts';
import type { ApiClient } from '../api/client.js';
import { boundedRead } from '../api/read-wait.js';

/** The profile of each source of the rows, read once each, for the display name and the icon of an entity type; a source whose profile cannot be read has none, its rows show what is stored, and it is asked for again at the next read of the list. */
export function useSourceProfiles(client: ApiClient, items: readonly InvestigationListItem[] | undefined): ReadonlyMap<string, SourceProfile> {
  const [profiles, setProfiles] = useState<ReadonlyMap<string, SourceProfile>>(new Map());
  const asked = useRef(new Set<string>());
  const abort = useRef(new AbortController());

  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    asked.current.clear();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    for (const sourceId of new Set((items ?? []).map((item) => item.sourceId))) {
      if (asked.current.has(sourceId)) continue;
      asked.current.add(sourceId);
      void boundedRead((signal) => client.getProfile(sourceId, signal), abort.current.signal).then((result) => {
        if (abort.current.signal.aborted) return;
        if (result.ok) setProfiles((held) => new Map(held).set(sourceId, result.value));
        else asked.current.delete(sourceId);
      });
    }
  }, [client, items]);

  return profiles;
}
