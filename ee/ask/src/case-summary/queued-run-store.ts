import type { RecordQueue } from '@neburyx/contracts';
import type { SummaryRunStore } from './run-store.js';

/**
 * A summary run store whose writes are queued, in the order made: the run row, each call's start and end, and the end of the run. A call of the model does not wait for any of them. The log metadata of a job names the run and the call and never text, and each job is safe to write twice.
 * The retention removal and the close pass through. With no queue attached a write is made at once.
 */
export function queuedSummaryRunStore(store: SummaryRunStore, queue: () => RecordQueue | undefined): SummaryRunStore {
  const queued = (ids: Record<string, string>, write: () => Promise<void>): Promise<void> => {
    const attached = queue();
    if (attached === undefined) return write();
    attached.enqueue({ ids, write });
    return Promise.resolve();
  };
  return {
    begin: (run) => queued({ runId: run.id, actorId: run.actorId, step: 'begin' }, () => store.begin(run)),
    beginCall: (call) => queued({ runId: call.runId, call: String(call.number), step: 'beginCall' }, () => store.beginCall(call)),
    endCall: (call) => queued({ runId: call.runId, call: String(call.number), step: 'endCall' }, () => store.endCall(call)),
    recordRemovals: (removals) => queued({ runId: removals.runId, call: String(removals.number), step: 'recordRemovals' }, () => store.recordRemovals(removals)),
    finish: (runId, outcome, calls, finishedAt) => queued({ runId, step: 'finish' }, () => store.finish(runId, outcome, calls, finishedAt)),
    removeStartedBefore: (moment) => store.removeStartedBefore(moment),
    close: () => store.close(),
  };
}
