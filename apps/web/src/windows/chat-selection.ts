import type { ClientState } from '../state/client-state.js';
import { createStore, type Store } from '../state/store.js';

/** The words under the element that a selection made in a chat window selected. */
export const CHAT_SELECTION_NOTE = 'Selected from the chat window';

const held = new WeakMap<object, Store<string | undefined>>();

/** The key of the element a chat window selected on this window's canvas while that selection stands, or none: it holds nothing but the key. */
export function chatSelectionOf(state: ClientState): Store<string | undefined> {
  const known = held.get(state);
  if (known !== undefined) return known;
  const made = createStore<string | undefined>(undefined);
  held.set(state, made);
  return made;
}
