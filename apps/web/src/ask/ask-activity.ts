import { createStore } from '../state/store.js';

/** Whether a question is being sent: a send cannot be cancelled, so nothing closes the panel while it is out. */
export const askSending = createStore<boolean>(false);
