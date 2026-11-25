import { useEffect, useRef, useState } from 'react';
import { ASSISTANT_CHAT_LOOKUP_IDS_MAX } from '@neburyx/contracts';
import { useApiClient } from '../../api/client-context.js';
import { READ_WAIT_MS } from '../read-wait.js';

/** What the picker knows of whether an investigation has a chat of the person: yes or no once the lookup has answered for it, and nothing while it has not or when it failed. */
export type ChatKnowledge = 'yes' | 'no' | 'unknown';

export interface ChatsOf {
  readonly chatOf: (id: string) => ChatKnowledge;
  /** A lookup failed or got no answer in time: the rows it was asked about make no claim, and `retry` asks about them again. */
  readonly failed: boolean;
  readonly retry: () => void;
}

/**
 * Which of the investigations drawn have a chat of the person. The ids not yet asked about are sent to the lookup in one call (a page of the list is at most 25, the call takes 100), once, and the answer is kept for as long as the picker is open. A call that fails, or gets no
 * answer in the time a read of the chat list may wait, leaves its ids `unknown`: no claim is made for them either way, `failed` says so and `retry` asks again. A late answer of a call that was given up is dropped.
 */
export function useChatsOf(ids: readonly string[]): ChatsOf {
  const client = useApiClient();
  const [known, setKnown] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(new Set());
  const [tries, setTries] = useState(0);
  const asked = useRef(new Set<string>());
  const mounted = useRef(true);
  const key = ids.join(',');
  useEffect(() => {
    const fresh = ids.filter((id) => !asked.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) asked.current.add(id);
    // a call takes at most 100 ids, whatever failed before and is asked again with the new rows
    for (let at = 0; at < fresh.length; at += ASSISTANT_CHAT_LOOKUP_IDS_MAX) {
      const batch = fresh.slice(at, at + ASSISTANT_CHAT_LOOKUP_IDS_MAX);
      const controller = new AbortController();
      let settled = false;
      const giveUp = (): void => {
        if (settled || !mounted.current) return;
        settled = true;
        controller.abort();
        for (const id of batch) asked.current.delete(id);
        setFailedIds((held) => new Set([...held, ...batch]));
      };
      const timer = window.setTimeout(giveUp, READ_WAIT_MS);
      void client.lookupAssistantChats(batch, controller.signal).then((result) => {
        window.clearTimeout(timer);
        if (settled || !mounted.current) return;
        settled = true;
        if (!result.ok) {
          // asked again when the rows change or from `retry`
          for (const id of batch) asked.current.delete(id);
          setFailedIds((held) => new Set([...held, ...batch]));
          return;
        }
        const withChat = new Set(result.value.withChat.map((id) => id.toLowerCase()));
        setKnown((held) => new Map([...held, ...batch.map((id) => [id, withChat.has(id.toLowerCase())] as const)]));
        setFailedIds((held) => (batch.some((id) => held.has(id)) ? new Set([...held].filter((id) => !batch.includes(id))) : held));
      });
    }
  }, [client, key, tries]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return {
    chatOf: (id) => {
      const found = known.get(id);
      return found === undefined ? 'unknown' : found ? 'yes' : 'no';
    },
    failed: ids.some((id) => failedIds.has(id)),
    retry: () => setTries((held) => held + 1),
  };
}
