const CHANNEL_PREFIX = 'neburyx-assistant-chat-cleared';

export interface ClearNotice {
  /** Tells the other sessions of this person in the browser that the chat of an investigation was cleared. The message holds the investigation's id and nothing else; the channel is the person's own. */
  announce(principalId: string, investigationId: string): void;
  /** Hears the notices of other sessions of this person; the returned function stops listening and closes the channel. */
  listen(principalId: string, onCleared: (investigationId: string) => void): () => void;
}

/** The investigation a message names, if it is a notice: an object with that one member as text, and nothing else. */
export function investigationOfNotice(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const entries = Object.entries(data);
  const [only] = entries;
  return entries.length === 1 && only?.[0] === 'investigationId' && typeof only[1] === 'string' && only[1] !== '' ? only[1] : undefined;
}

/** The notice of the browser, or none where the browser has no such channel: a window that cannot hear one reconciles from the server when it is shown again. */
export function browserClearNotice(): ClearNotice | undefined {
  if (typeof BroadcastChannel === 'undefined') return undefined;
  const open = (principalId: string): BroadcastChannel | undefined => {
    try {
      return new BroadcastChannel(`${CHANNEL_PREFIX}:${principalId}`);
    } catch {
      return undefined;
    }
  };
  const senders = new Map<string, BroadcastChannel>();
  return {
    announce(principalId, investigationId) {
      try {
        const sender = senders.get(principalId) ?? open(principalId);
        if (sender === undefined) return;
        senders.set(principalId, sender);
        sender.postMessage({ investigationId });
      } catch {
        // the clearing itself has succeeded: a channel that fails changes nothing
      }
    },
    listen(principalId, onCleared) {
      const channel = open(principalId);
      if (channel === undefined) return () => undefined;
      channel.onmessage = (event: MessageEvent) => {
        const id = investigationOfNotice(event.data);
        if (id !== undefined) onCleared(id);
      };
      return () => channel.close();
    },
  };
}
