import type { RecordJob, RecordQueue } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { queuedSummaryRunStore } from './queued-run-store.js';
import { createMemorySummaryRunStore } from './run-store.js';

const AT = new Date('2026-11-17T10:00:00.000Z');
const ID = '01939999-0000-4000-8000-000000000001';

function rig() {
  const jobs: RecordJob[] = [];
  const memory = createMemorySummaryRunStore();
  const queue: RecordQueue = { enqueue: (job) => void jobs.push(job) };
  return { jobs, memory, store: queuedSummaryRunStore(memory, () => queue) };
}

describe('the queued summary run store', () => {
  it('queues the run row, each call and the end of the run in the order made, and writes none of them until the jobs run', async () => {
    const { jobs, memory, store } = rig();
    await store.begin({ id: ID, actorId: 'a', sourceId: 's', traceId: 't', startedAt: AT, settings: {} });
    await store.beginCall({ runId: ID, number: 1, startedAt: AT, instructionsSha256: 'x', instructionsText: 'SECRET-INSTRUCTIONS', valuesText: 'SECRET-VALUES' });
    await store.endCall({ runId: ID, number: 1, status: 'answered', replyText: 'SECRET-REPLY', durationMs: 5 });
    await store.finish(ID, 'ok', 1, AT);
    expect(memory.runs).toEqual([]);
    expect(jobs.map((job) => job.ids['step'])).toEqual(['begin', 'beginCall', 'endCall', 'finish']);
    for (const job of jobs) await job.write();
    expect(memory.runs[0]).toMatchObject({ id: ID, outcome: 'ok', calls: 1 });
    expect(memory.runs[0]?.callEnds[0]).toMatchObject({ replyText: 'SECRET-REPLY' });
  });

  it('names the run and the call in its log metadata and never a word of what was sent or returned', async () => {
    const { jobs, store } = rig();
    await store.begin({ id: ID, actorId: 'a', sourceId: 's', traceId: 't', startedAt: AT, settings: { model: 'SECRET-MODEL' } });
    await store.beginCall({ runId: ID, number: 2, startedAt: AT, instructionsSha256: 'x', instructionsText: 'SECRET-INSTRUCTIONS', valuesText: 'SECRET-VALUES' });
    await store.endCall({ runId: ID, number: 2, status: 'failed', failureKind: 'SECRET-KIND', replyText: 'SECRET-REPLY', durationMs: 5 });
    expect(JSON.stringify(jobs.map((job) => job.ids))).not.toContain('SECRET');
    expect(jobs[1]?.ids).toEqual({ runId: ID, call: '2', step: 'beginCall' });
  });

  it('returns at once whatever the store does, so no call of the model waits for a record', async () => {
    const jobs: RecordJob[] = [];
    const never = { ...createMemorySummaryRunStore(), begin: () => new Promise<void>(() => undefined) };
    const store = queuedSummaryRunStore(never, () => ({ enqueue: (job) => void jobs.push(job) }));
    await expect(store.begin({ id: ID, actorId: 'a', sourceId: 's', traceId: 't', startedAt: AT, settings: {} })).resolves.toBeUndefined();
    expect(jobs).toHaveLength(1);
  });

  it('writes a job twice with one effect, as a retry does', async () => {
    const { jobs, memory, store } = rig();
    await store.begin({ id: ID, actorId: 'a', sourceId: 's', traceId: 't', startedAt: AT, settings: {} });
    await jobs[0]?.write();
    await jobs[0]?.write();
    expect(memory.runs).toHaveLength(1);
  });

  it('removes old runs and closes through the store itself, and writes at once with no queue attached', async () => {
    const memory = createMemorySummaryRunStore();
    const store = queuedSummaryRunStore(memory, () => undefined);
    await store.begin({ id: ID, actorId: 'a', sourceId: 's', traceId: 't', startedAt: AT, settings: {} });
    expect(memory.runs).toHaveLength(1);
    expect(await store.removeStartedBefore(new Date(AT.getTime() + 1))).toBe(1);
    await expect(store.close()).resolves.toBeUndefined();
  });
});
