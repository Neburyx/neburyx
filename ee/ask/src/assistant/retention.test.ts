import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnterpriseExtension } from '../index.js';
import { makeAskFolder, removeAskFolders } from '../testing/ask-folder.js';
import { createMemoryAssistantRunStore, type AssistantRunStore } from './run-store.js';

afterAll(removeAskFolders);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-15T12:00:00Z');
const SINK_CONTEXT = { databaseUrl: 'postgres://app@db.example.test:5432/neburyx', poolSize: 1, connectionTimeoutMs: 100, statementTimeoutMs: 100, queryTimeoutMs: 100, newId: () => 'id', onConnectionError: () => undefined };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function mounted(env: Record<string, string> = {}, store: AssistantRunStore = createMemoryAssistantRunStore(), warnings: unknown[] = []) {
  const removals: Date[] = [];
  const wrapped: AssistantRunStore = { ...store, removeStartedBefore: async (moment) => (removals.push(moment), store.removeStartedBefore(moment)) };
  const extension = createEnterpriseExtension({ features: { ask: false, summary: false, assistant: true }, assistantRunStore: () => wrapped, now: () => NOW, retentionIntervalMs: 1000 });
  extension.attachLogger?.({ warn: (...args: unknown[]) => void warnings.push(args), info: () => undefined, error: () => undefined } as never);
  await extension.configure?.({}, { NEBURYX_ASK_API_KEY: 'k', NEBURYX_ASK_MAPPING_FOLDER: makeAskFolder(['s1']), ...env }, { sourceIds: ['s1'] });
  const sink = extension.createAuditSink?.(SINK_CONTEXT);
  return { extension, sink, removals };
}

describe('the removal of old assistant turn records', () => {
  it('runs at start-up with a cutoff of the retention period (30 days by default) before now', async () => {
    const { sink, removals } = await mounted();
    expect(removals).toEqual([new Date(NOW - 30 * DAY)]);
    await sink?.close();
  });

  it('uses the retention days the setting names', async () => {
    const { sink, removals } = await mounted({ NEBURYX_ASSISTANT_RUN_RETENTION_DAYS: '7' });
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
    const store = createMemoryAssistantRunStore();
    const cutoff = NOW - 30 * DAY;
    const base = { actorId: 'a', sourceId: 's', traceId: 't', settings: {} };
    const before = '00000000-0000-7000-8000-000000000001';
    const at = '00000000-0000-7000-8000-000000000002';
    await store.begin({ ...base, id: before, startedAt: new Date(cutoff - 1) });
    await store.begin({ ...base, id: at, startedAt: new Date(cutoff) });
    const { sink } = await mounted({}, store);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.runs.map((run) => run.id)).toEqual([at]);
    expect(store.runs.map((run) => run.id)).not.toContain(before);
    await sink?.close();
  });

  it('logs one fixed line, holding nothing of the failure, when the removal fails, and goes on', async () => {
    const warnings: unknown[] = [];
    const failing: AssistantRunStore = { ...createMemoryAssistantRunStore(), removeStartedBefore: () => Promise.reject(new Error('password for actor X failed')) };
    const { sink } = await mounted({}, failing, warnings);
    await vi.advanceTimersByTimeAsync(1500);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(warnings)).not.toMatch(/password|actor/);
    expect(warnings[0]).toEqual([{ event: 'assistant-runs.removal_failed' }, 'the removal of old assistant turn records failed']);
    await sink?.close();
  });

  it('closes the store with the sink', async () => {
    let closed = 0;
    const base = createMemoryAssistantRunStore();
    const { sink } = await mounted({}, { ...base, close: async () => void (closed += 1) });
    await sink?.close();
    expect(closed).toBe(1);
  });
});
