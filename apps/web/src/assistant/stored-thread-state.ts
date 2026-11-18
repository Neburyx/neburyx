import type { AssistantThreadResponse } from '@neburyx/contracts';

/** What the panel holds of the thread the server kept: nothing yet, a read in flight, the turns and when the previous thread was cleared, a read that failed, a read the investigation's access was lost on, or one the assistant's being off ended. The last three end the reading until the session is cleared. */
export type StoredThreadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly thread: AssistantThreadResponse }
  | { readonly kind: 'failed' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'off' };

export const NO_STORED_THREAD: StoredThreadState = { kind: 'idle' };
