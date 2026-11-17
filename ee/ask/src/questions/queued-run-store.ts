import type { RecordQueue } from '@neburyx/contracts';
import type { RunStore } from './run-store.js';

/** A run store whose writes are queued: the record is handed to the queue and the call goes on at once, with no wait for the store. With no queue attached the record is written at once. */
export function queuedRunStore(store: RunStore, queue: () => RecordQueue | undefined): RunStore {
  return {
    record(run) {
      const attached = queue();
      if (attached === undefined) return store.record(run);
      attached.enqueue({ ids: { runId: run.id, actorId: run.actorId }, write: () => store.record(run) });
      return Promise.resolve();
    },
  };
}
