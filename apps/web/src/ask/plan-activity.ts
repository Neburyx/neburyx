import { createStore } from '../state/store.js';

/** Whether a plan is being run, edited or cancelled: such a call cannot be taken back once the server has it, so nothing closes the panel while it is out. */
export const planOut = createStore<boolean>(false);
