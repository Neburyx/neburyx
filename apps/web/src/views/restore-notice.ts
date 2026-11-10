import type { ClientState } from '../state/client-state.js';
import { createStore, type ReadableStore } from '../state/store.js';

/** Whether the last restore of a view left out items that cannot be read again: the workspace says so as it does after a reopen. */
export interface RestoreNotice {
  readonly missing: ReadableStore<boolean>;
  set(missing: boolean): void;
}

const notices = new WeakMap<ClientState, RestoreNotice>();

export function restoreNoticeOf(state: ClientState): RestoreNotice {
  let notice = notices.get(state);
  if (notice === undefined) {
    const store = createStore(false);
    notice = { missing: store, set: (missing) => store.setState(missing) };
    notices.set(state, notice);
    // another investigation takes the place of the one restored
    let shown = state.investigation.getState().id;
    state.investigation.subscribe(() => {
      const now = state.investigation.getState().id;
      if (now !== shown) store.setState(false);
      shown = now;
    });
  }
  return notice;
}
