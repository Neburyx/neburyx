import type { RecordJob, RecordQueue } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { queuedRunStore } from './queued-run-store.js';
import type { RunRecord, RunStore } from './run-store.js';

const RUN: RunRecord = { id: '01939999-0000-4000-8000-000000000001', actorId: 'actor-1', intent: 'entity', outcome: 'complete', rowCount: 3, elapsedMs: 12 };

function rig() {
  const written: RunRecord[] = [];
  const jobs: RecordJob[] = [];
  const store: RunStore = { record: (run) => (written.push(run), Promise.resolve()) };
  const queue: RecordQueue = { enqueue: (job) => void jobs.push(job) };
  return { written, jobs, store, queue };
}

describe('the queued run store', () => {
  it('hands the record to the queue and returns at once, without writing it', async () => {
    const { written, jobs, store, queue } = rig();
    await queuedRunStore(store, () => queue).record(RUN);
    expect(written).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.ids).toEqual({ runId: RUN.id, actorId: 'actor-1' });
    await jobs[0]?.write();
    expect(written).toEqual([RUN]);
  });

  it('writes the same record each time the job is written, so a retry repeats the one insert of its id', async () => {
    const { written, jobs, store, queue } = rig();
    await queuedRunStore(store, () => queue).record(RUN);
    await jobs[0]?.write();
    await jobs[0]?.write();
    expect(written.map((run) => run.id)).toEqual([RUN.id, RUN.id]);
  });

  it('carries the ids of the run and never its intent or its numbers', async () => {
    const { jobs, store, queue } = rig();
    await queuedRunStore(store, () => queue).record(RUN);
    expect(JSON.stringify(jobs[0]?.ids)).not.toMatch(/entity|complete|"3"|12/);
  });

  it('writes the record at once when no queue is attached, and a failure of that write reaches the caller', async () => {
    const { written, store } = rig();
    await queuedRunStore(store, () => undefined).record(RUN);
    expect(written).toEqual([RUN]);
    const failing: RunStore = { record: () => Promise.reject(new Error('down')) };
    await expect(queuedRunStore(failing, () => undefined).record(RUN)).rejects.toThrow('down');
  });
});
