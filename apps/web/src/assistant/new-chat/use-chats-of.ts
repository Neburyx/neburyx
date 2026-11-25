import { useEffect, useRef, useState } from 'react';
import { useApiClient } from '../../api/client-context.js';

/** What the picker knows of whether an investigation has a chat of the person: yes or no once the lookup has answered for it, and nothing while it has not or when it failed. */
export type ChatKnowledge = 'yes' | 'no' | 'unknown';

/**
 * Which of the investigations drawn have a chat of the person. The ids not yet asked about are sent to the lookup in one call (a page of the list is at most 25, the call takes 100), once, and the answer is kept for as long as the picker is open; a call that
 * fails leaves its ids `unknown`: no claim is made for them either way.
 */
export function useChatsOf(ids: readonly string[]): (id: string) => ChatKnowledge {
  const client = useApiClient();
  const [known, setKnown] = useState<ReadonlyMap<string, boolean>>(new Map());
  const asked = useRef(new Set<string>());
  const mounted = useRef(true);
  const key = ids.join(',');
  useEffect(() => {
    const fresh = ids.filter((id) => !asked.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) asked.current.add(id);
    void client.lookupAssistantChats(fresh).then((result) => {
      if (!mounted.current) return;
      if (!result.ok) {
        // asked again when the rows change
        for (const id of fresh) asked.current.delete(id);
        return;
      }
      const withChat = new Set(result.value.withChat.map((id) => id.toLowerCase()));
      setKnown((held) => new Map([...held, ...fresh.map((id) => [id, withChat.has(id.toLowerCase())] as const)]));
    });
  }, [client, key]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (id) => {
    const found = known.get(id);
    return found === undefined ? 'unknown' : found ? 'yes' : 'no';
  };
}
