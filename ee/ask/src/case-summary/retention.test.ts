import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnterpriseExtension } from '../index.js';
import { makeAskFolder, removeAskFolders } from '../testing/ask-folder.js';
import { createMemorySummaryRunStore, type SummaryRunStore } from './run-store.js';

afterAll(removeAskFolders);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-15T12:00:00Z');
const SINK_CONTEXT = { databaseUrl: 'postgres://app@db.example.test:5432/neburyx', poolSize: 1, connectionTimeoutMs: 100, statementTimeoutMs: 100, queryTimeoutMs: 100, newId: () => 'id', onConnectionError: () => undefined };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function mounted(env: Record<string, string> = {}, store: SummaryRunStore = createMemorySummaryRunStore(), warnings: unknown[] = []) {
  const removals: Date[] = [];
  const wrapped: SummaryRunStore = { ...store, removeStartedBefore: async (moment) => (removals.push(moment), store.removeStartedBefore(moment)) };
  const extension = createEnterpriseExtension({ summaryRunStore: () => wrapped, now: () => NOW, retentionIntervalMs: 1000 });
  extension.attachLogger?.({ warn: (...args: unknown[]) => void warnings.push(args), info: () => undefined, error: () => undefined } as never);
  await extension.configure?.({}, { NEBURYX_ASK_API_KEY: 'k', NEBURYX_ASK_MAPPING_FOLDER: makeAskFolder(['s1']), ...env }, { sourceIds: ['s1'] });
  const sink = extension.createAuditSink?.(SINK_CONTEXT);
  return { extension, sink, removals };
}

describe('the removal of old case summary records', () => {
  it('runs at start-up with a cutoff of the retention period (30 days by default) before now', async () => {
    const { sink, removals } = await mounted();
    expect(removals).toEqual([new Date(NOW - 30 * DAY)]);
    await sink?.close();
  });

  it('uses the retention days the setting names', async () => {
    const { sink, removals } = await mounted({ NEBURYX_SUMMARY_RUN_RETENTION_DAYS: '7' });
    expect(removals).toEqual([new Date(NOW - 7 * DAY)]);
    await sink?.close();
  });

  it('runs again on the interval, and stops when the sink is closed', async () => {
    const { sink, removals } = await mounted();
    await vi.advanceTimersByTimeAsync(2500);
    expect(removals).toHaveLength(3);
    await sink?.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(removals).toHaveLength(3);
  });

  it('keeps a run that started exactly at the cutoff and removes one that started a moment before', async () => {
    const store = createMemorySummaryRunStore();
    const cutoff = NOW - 30 * DAY;
    const base = { actorId: 'a', sourceId: 's', traceId: 't', settings: {} };
    const before = await store.begin({ ...base, startedAt: new Date(cutoff - 1) });
    const at = await store.begin({ ...base, startedAt: new Date(cutoff) });
    const { sink } = await mounted({}, store);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.runs.map((run) => run.id)).toEqual([at]);
    expect(store.runs.map((run) => run.id)).not.toContain(before);
    await sink?.close();
  });

  it('logs one fixed line, holding nothing of the failure, when the removal fails, and goes on', async () => {
    const warnings: unknown[] = [];
    const failing: SummaryRunStore = { ...createMemorySummaryRunStore(), removeStartedBefore: () => Promise.reject(new Error('password for actor X failed')) };
    const { sink } = await mounted({}, failing, warnings);
    await vi.advanceTimersByTimeAsync(1500);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(warnings)).not.toMatch(/password|actor/);
    expect(warnings[0]).toEqual([{ event: 'summary-runs.removal_failed' }, 'the removal of old case summary records failed']);
    await sink?.close();
  });

  it('closes the store with the sink', async () => {
    let closed = 0;
    const base = createMemorySummaryRunStore();
    const { sink } = await mounted({}, { ...base, close: async () => void (closed += 1) });
    await sink?.close();
    expect(closed).toBe(1);
  });
});
