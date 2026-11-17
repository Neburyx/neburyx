import { createRequire, syncBuiltinESMExports } from 'node:module';
import { ExtensionRefusal, type AuditEvent, type AuditSink, type ExtensionRequest } from '@neburyx/contracts';
import type * as WorkerThreads from 'node:worker_threads';
import { JUDGE_MODULE, createCheckRunner, judgeSentences, parseJudged } from '@neburyx/ee-ai-runtime';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemorySummaryRunStore } from './case-summary/run-store.js';
import { makeAskFolder, removeAskFolders } from './testing/ask-folder.js';

const sink: AuditSink = { record: async () => undefined };
const providerCalls = vi.hoisted(() => ({ made: 0 }));

vi.mock('@neburyx/ee-audit', () => ({ createAuditSink: () => ({ sink, close: async () => undefined }) }));
vi.mock('@neburyx/ee-ai-runtime', async (importOriginal) => {
  const original = await importOriginal<typeof import('@neburyx/ee-ai-runtime')>();
  return { ...original, createAnthropicProvider: (...args: Parameters<typeof original.createAnthropicProvider>) => (providerCalls.made++, original.createAnthropicProvider(...args)) };
});

const { createEnterpriseExtension } = await import('./index.js');

const SINK_CONTEXT = { databaseUrl: 'postgres://app@db.example.test:5432/neburyx', poolSize: 1, connectionTimeoutMs: 100, statementTimeoutMs: 100, queryTimeoutMs: 100, newId: () => 'id', onConnectionError: () => undefined };
const CONTEXT = { sourceIds: ['source-a'] };
const FOLDER = makeAskFolder(CONTEXT.sourceIds);
const ENV = { NEBURYX_ASK_API_KEY: 'not-a-real-key', NEBURYX_ASK_MAPPING_FOLDER: FOLDER };

afterAll(removeAskFolders);

/** Counts the worker threads made, by wrapping the class the package imports from `node:worker_threads`. */
const threads = { made: 0 };
const workerThreads: typeof WorkerThreads = createRequire(import.meta.url)('node:worker_threads');
const OriginalWorker = workerThreads.Worker;
beforeAll(() => {
  workerThreads.Worker = class extends OriginalWorker {
    constructor(...args: ConstructorParameters<typeof OriginalWorker>) {
      threads.made += 1;
      super(...args);
    }
  };
  syncBuiltinESMExports();
});
afterAll(() => {
  workerThreads.Worker = OriginalWorker;
  syncBuiltinESMExports();
});
beforeEach(() => {
  vi.useFakeTimers();
  providerCalls.made = 0;
  threads.made = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

/** The AI resources of an extension: the pools of the two run stores, the timer of the removal of old summary records and the model clients made. */
function counted(features?: { ask?: boolean; summary?: boolean }) {
  const pools = { ask: 0, summary: 0 };
  const extension = createEnterpriseExtension({
    ...(features === undefined ? {} : { features }),
    runStore: () => (pools.ask++, { record: async () => undefined, close: async () => undefined }),
    summaryRunStore: () => (pools.summary++, { ...createMemorySummaryRunStore(), close: async () => undefined }),
  });
  return { extension, pools };
}

describe('the AI code before and after it is asked to start', () => {
  it('holds no pool, no timer, no thread and no model client when the extension is only created', () => {
    const { pools } = counted();
    expect(pools).toEqual({ ask: 0, summary: 0 });
    expect(vi.getTimerCount()).toBe(0);
    expect(providerCalls.made).toBe(0);
    expect(threads.made).toBe(0);
  });

  it('counts a thread when a check is run off the main thread, so that the count of zero means something', async () => {
    vi.useRealTimers();
    let now = 0;
    const runner = createCheckRunner({ thresholdMs: 1, clock: () => now });
    const check = { name: 'counted', inline: () => ((now += 100), { kept: [], removed: 0, keysStripped: 0, keysRemoved: 0, verdictFound: false }), module: JUDGE_MODULE, parse: parseJudged };
    const text = { text: '', keys: new Map<string, boolean>(), lines: new Map<string, string>(), inexactCounts: [], unknownCountKeys: new Set<string>() };
    await runner.run(check, { sentences: [], text }, { timeoutMs: 10_000 });
    expect(threads.made).toBe(0);
    await runner.run(check, { sentences: [], text }, { timeoutMs: 10_000 });
    expect(threads.made).toBe(1);
    expect(judgeSentences([], text).removed).toBe(0);
  });

  it('holds no pool and no timer after configure, until the audit sink is mounted, and makes no model client', async () => {
    const { extension, pools } = counted();
    expect((await extension.configure?.({ preview: true }, ENV, CONTEXT))?.ok).toBe(true);
    expect(pools).toEqual({ ask: 0, summary: 0 });
    expect(vi.getTimerCount()).toBe(0);
    expect(providerCalls.made).toBe(0);
    expect(threads.made).toBe(0);
  });

  it('opens both run stores and starts the removal of old summary records when both features are on', async () => {
    const { extension, pools } = counted();
    await extension.configure?.({ preview: true }, ENV, CONTEXT);
    const mounted = extension.createAuditSink?.(SINK_CONTEXT);
    expect(pools).toEqual({ ask: 1, summary: 1 });
    expect(vi.getTimerCount()).toBe(1);
    await mounted?.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('opens no Ask pool and loads no folder with Ask off, and its summary keeps its own provider settings', async () => {
    const { extension, pools } = counted({ ask: false });
    const outcome = await extension.configure?.({ preview: true }, { NEBURYX_ASK_API_KEY: 'not-a-real-key' }, CONTEXT);
    expect(outcome?.ok).toBe(true);
    extension.createAuditSink?.(SINK_CONTEXT);
    expect(pools).toEqual({ ask: 0, summary: 1 });
    expect(vi.getTimerCount()).toBe(1);
    expect(extension.askFolder()).toBeUndefined();
    expect(extension.askClassifier()).toBeUndefined();
    expect(extension.summarySettings()).toBeDefined();
    expect(extension.caseSummarizer?.()).toBeDefined();
  });

  it('opens no summary pool and starts no timer with the summary off, and Ask works as before', async () => {
    const { extension, pools } = counted({ summary: false });
    expect((await extension.configure?.({ preview: true }, ENV, CONTEXT))?.ok).toBe(true);
    extension.createAuditSink?.(SINK_CONTEXT);
    expect(pools).toEqual({ ask: 1, summary: 0 });
    expect(vi.getTimerCount()).toBe(0);
    expect(extension.askClassifier()).toBeDefined();
    expect(extension.caseSummarizer?.()).toBeUndefined();
    expect(extension.summarySettings()).toBeUndefined();
  });

  it('needs no provider setting and opens nothing with both features off', async () => {
    const { extension, pools } = counted({ ask: false, summary: false });
    expect((await extension.configure?.({ preview: true }, {}, CONTEXT))?.ok).toBe(true);
    extension.createAuditSink?.(SINK_CONTEXT);
    expect(pools).toEqual({ ask: 0, summary: 0 });
    expect(vi.getTimerCount()).toBe(0);
    expect(providerCalls.made).toBe(0);
    expect(threads.made).toBe(0);
  });
});

describe('a route of a feature that is switched off', () => {
  const requestOf = (events: AuditEvent[]): ExtensionRequest => ({ principalId: 'p', principalRole: 'investigator', previewOn: true, traceId: 'tr-1', audit: { record: async (event) => void events.push(event) }, askClassifier: { availability: () => ({ available: false, reason: 'not_in_this_edition' }), classify: async () => ({ ok: false, cause: 'unavailable' }) }, caseSummarizer: createEnterpriseExtension().caseSummarizer?.() ?? { maxElements: 0, availability: () => ({ available: false, reason: 'not_in_this_edition' }), summarize: () => Promise.reject(new Error('unavailable')), renderForExport: () => ({ status: 'refused' }), recordEarlyEnd: async () => undefined }, signal: new AbortController().signal });
  const routeOf = (extension: ReturnType<typeof createEnterpriseExtension>, url: string) => extension.routeGroups[0]?.routes.find((route) => route.url === url);

  it('refuses a question with the refusal of the preview switch and records it, while a summary route is not refused for that reason', async () => {
    const extension = createEnterpriseExtension({ features: { ask: false } });
    const events: AuditEvent[] = [];
    await expect(routeOf(extension, '/v1/ask')?.handler(requestOf(events)) ?? Promise.resolve()).rejects.toMatchObject({ code: 'ACCESS_DENIED', reason: 'ai-preview-off', audited: true });
    expect(events).toHaveLength(1);
    const summary = await (routeOf(extension, '/v1/summary')?.handler(requestOf(events)) ?? Promise.resolve()).catch((error: unknown) => error);
    expect(summary instanceof ExtensionRefusal && summary.reason === 'ai-preview-off').toBe(false);
  });

  it('refuses a summary with the same refusal while a question is not refused for that reason', async () => {
    const extension = createEnterpriseExtension({ features: { summary: false } });
    const events: AuditEvent[] = [];
    await expect(routeOf(extension, '/v1/summary')?.handler(requestOf(events)) ?? Promise.resolve()).rejects.toMatchObject({ code: 'ACCESS_DENIED', reason: 'ai-preview-off' });
    const ask = await (routeOf(extension, '/v1/ask')?.handler(requestOf(events)) ?? Promise.resolve()).catch((error: unknown) => error);
    expect(ask instanceof ExtensionRefusal && ask.reason === 'ai-preview-off').toBe(false);
  });

  it('leaves the status route open whichever feature is off', async () => {
    const extension = createEnterpriseExtension({ features: { ask: false, summary: false } });
    expect(await routeOf(extension, '/v1/ai/status')?.handler(requestOf([]))).toEqual({ preview: true });
  });
});
