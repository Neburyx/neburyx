import type { DroppedFilter } from '@neburyx/contracts';
import type { ClientState } from '../state/client-state.js';
import { createStore, readable, type ReadableStore } from '../state/store.js';

export interface MappingNotice {
  readonly investigationId: string;
  readonly droppedFilters: readonly DroppedFilter[];
  readonly hasUnmapped: boolean;
  /** False for an investigation that cannot be changed: the banner of that state is the one shown, and nothing is written. */
  readonly canChange: boolean;
  /** Called once the banner has been on screen: the write that stores the draft under the current mapping waits for it. */
  readonly onShown?: () => void;
}

export interface MappingNotices {
  readonly notice: ReadableStore<MappingNotice | undefined>;
  set(notice: MappingNotice | undefined): void;
}

const held = new WeakMap<ClientState, MappingNotices>();

/** The one mapping notice of a client state: it lives as long as the state does, so the banner can be drawn by a component the open flow knows nothing of. */
export function mappingNoticesOf(state: ClientState): MappingNotices {
  let notices = held.get(state);
  if (notices === undefined) {
    const store = createStore<MappingNotice | undefined>(undefined);
    notices = { notice: readable(store), set: (next) => store.setState(next) };
    held.set(state, notices);
  }
  return notices;
}
