import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtensionRefusal, type AuditEvent, type AuditSink, type ExtensionRequest } from '@neburyx/contracts';
import type * as WorkerThreads from 'node:worker_threads';
import { JUDGE_MODULE, createCheckRunner, judgeSentences, parseJudged } from '@neburyx/ee-ai-runtime';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemorySummaryRunStore } from './case-summary/run-store.js';
import { createMemoryAssistantRunStore } from './assistant/run-store.js';
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
function counted(features?: { ask?: boolean; summary?: boolean; assistant?: boolean }) {
  const pools = { ask: 0, summary: 0, assistant: 0 };
  const extension = createEnterpriseExtension({
    ...(features === undefined ? {} : { features }),
    runStore: () => (pools.ask++, { record: async () => undefined, close: async () => undefined }),
    summaryRunStore: () => (pools.summary++, { ...createMemorySummaryRunStore(), close: async () => undefined }),
    assistantRunStore: () => (pools.assistant++, { ...createMemoryAssistantRunStore(), close: async () => undefined }),
  });
  return { extension, pools };
}

describe('the AI code before and after it is asked to start', () => {
  it('holds no pool, no timer, no thread and no model client when the extension is only created', () => {
    const { pools } = counted();
    expect(pools).toEqual({ ask: 0, summary: 0, assistant: 0 });
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
    expect(pools).toEqual({ ask: 0, summary: 0, assistant: 0 });
    expect(vi.getTimerCount()).toBe(0);
    expect(providerCalls.made).toBe(0);
    expect(threads.made).toBe(0);
  });

  it('opens both run stores and starts the removal of old summary records when both features are on', async () => {
    const { extension, pools } = counted();
    await extension.configure?.({ preview: true }, ENV, CONTEXT);
    const mounted = extension.createAuditSink?.(SINK_CONTEXT);
    expect(pools).toEqual({ ask: 1, summary: 1, assistant: 1 });
    expect(vi.getTimerCount()).toBe(1);
    await mounted?.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('opens no Ask pool and loads no folder with Ask off, and its summary keeps its own provider settings', async () => {
    const { extension, pools } = counted({ ask: false });
    const outcome = await extension.configure?.({ preview: true }, { NEBURYX_ASK_API_KEY: 'not-a-real-key' }, CONTEXT);
    expect(outcome?.ok).toBe(true);
    extension.createAuditSink?.(SINK_CONTEXT);
    expect(pools).toEqual({ ask: 0, summary: 1, assistant: 1 });
    expect(vi.getTimerCount()).toBe(1);
    expect(extension.askFolder()).toBeUndefined();
    expect(extension.askClassifier()).toBeUndefined();
    expect(extension.summarySettings()).toBeDefined();
    expect(extension.caseSummarizer?.()).toBeDefined();
  });

  it('opens no summary pool and starts no timer with the summary off, and Ask works as before', async () => {
    const { extension, pools } = counted({ summary: false, assistant: false });
    expect((await extension.configure?.({ preview: true }, ENV, CONTEXT))?.ok).toBe(true);
    extension.createAuditSink?.(SINK_CONTEXT);
    expect(pools).toEqual({ ask: 1, summary: 0, assistant: 0 });
    expect(vi.getTimerCount()).toBe(0);
    expect(extension.askClassifier()).toBeDefined();
    expect(extension.caseSummarizer?.()).toBeUndefined();
    expect(extension.summarySettings()).toBeUndefined();
  });

  it('takes the features the application decided from the context of configure, over the ones it was created with', async () => {
    const { extension, pools } = counted();
    expect((await extension.configure?.({ preview: true }, { NEBURYX_ASK_API_KEY: 'not-a-real-key' }, { ...CONTEXT, features: { ask: false, summary: true, assistant: true } }))?.ok).toBe(true);
    extension.createAuditSink?.(SINK_CONTEXT);
    expect(pools).toEqual({ ask: 0, summary: 1, assistant: 1 });
    expect(extension.askFolder()).toBeUndefined();
  });

  it('needs no provider setting and opens nothing with all three features off', async () => {
    const { extension, pools } = counted({ ask: false, summary: false, assistant: false });
    expect((await extension.configure?.({ preview: true }, {}, CONTEXT))?.ok).toBe(true);
    extension.createAuditSink?.(SINK_CONTEXT);
    expect(pools).toEqual({ ask: 0, summary: 0, assistant: 0 });
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
    await expect(routeOf(extension, '/v1/ask')?.handler(requestOf(events)) ?? Promise.resolve()).rejects.toMatchObject({ code: 'ACCESS_DENIED', reason: 'ai-off', audited: true });
    expect(events).toHaveLength(1);
    const summary = await (routeOf(extension, '/v1/summary')?.handler(requestOf(events)) ?? Promise.resolve()).catch((error: unknown) => error);
    expect(summary instanceof ExtensionRefusal && summary.reason === 'ai-off').toBe(false);
  });

  it('refuses a summary with the same refusal while a question is not refused for that reason', async () => {
    const extension = createEnterpriseExtension({ features: { summary: false } });
    const events: AuditEvent[] = [];
    await expect(routeOf(extension, '/v1/summary')?.handler(requestOf(events)) ?? Promise.resolve()).rejects.toMatchObject({ code: 'ACCESS_DENIED', reason: 'ai-off' });
    const ask = await (routeOf(extension, '/v1/ask')?.handler(requestOf(events)) ?? Promise.resolve()).catch((error: unknown) => error);
    expect(ask instanceof ExtensionRefusal && ask.reason === 'ai-off').toBe(false);
  });

  it('says which features can be used: none before the extension is mounted, Ask once its folder and sink are in, the summary only with its token key, and the assistant once its model and sink are in', async () => {
    const { extension } = counted();
    expect(extension.aiAvailability?.()).toEqual({ ask: { available: false }, summary: { available: false }, assistant: { available: false } });
    await extension.configure?.({ preview: true }, ENV, CONTEXT);
    extension.createAuditSink?.(SINK_CONTEXT);
    expect(extension.aiAvailability?.()).toEqual({ ask: { available: true }, summary: { available: false }, assistant: { available: true, messageWords: 1000 } });
  });

  it('says the summary is available once its token key file is set', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'idle-token-key-'));
    try {
      const path = join(directory, 'key');
      writeFileSync(path, 'ab'.repeat(32), { mode: 0o600 });
      const { extension } = counted();
      await extension.configure?.({ preview: true }, { ...ENV, NEBURYX_SUMMARY_TOKEN_KEY_FILE: path }, CONTEXT);
      extension.createAuditSink?.(SINK_CONTEXT);
      expect(extension.aiAvailability?.()).toEqual({ ask: { available: true }, summary: { available: true }, assistant: { available: true, messageWords: 1000 } });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('warns at start-up, naming the type and the rule and holding no text, of a description the assistant will not use, and not when the assistant is off', async () => {
    const withVerdict = { 'source-a': { entityTypes: [{ type: 'widget', label: 'Widget', displayName: 'Widget', description: 'A widget is SENTINEL-TEXT proof of fraud.' }], relationshipTypes: [] } };
    const on = counted({ ask: false, summary: false });
    const outcome = await on.extension.configure?.({ preview: true }, ENV, { ...CONTEXT, typeDescriptions: withVerdict });
    expect(outcome).toEqual({ ok: true, warnings: [{ event: 'assistant.description_withheld', message: expect.stringContaining('the entity type "widget"') }] });
    expect(JSON.stringify(outcome)).not.toContain('SENTINEL-TEXT');
    const off = counted({ ask: false, summary: false, assistant: false });
    const quiet = await off.extension.configure?.({ preview: true }, ENV, { ...CONTEXT, typeDescriptions: withVerdict, features: { ask: false, summary: false, assistant: false } });
    expect(JSON.stringify(quiet)).not.toContain('description_withheld');
  });

  it('says a feature that is off is not available whatever else is in place', async () => {
    const { extension } = counted({ ask: false });
    await extension.configure?.({ preview: true }, ENV, CONTEXT);
    extension.createAuditSink?.(SINK_CONTEXT);
    expect(extension.aiAvailability?.().ask).toEqual({ available: false });
  });

  it('starts the assistant without the folder of Ask questions when Ask is off and the folder cannot be used, with a warning, and refuses the same folder when Ask is on', async () => {
    const missing = { ...ENV, NEBURYX_ASK_MAPPING_FOLDER: '/not/there' };
    const off = counted({ ask: false, summary: false });
    const outcome = await off.extension.configure?.({ preview: true }, missing, CONTEXT);
    expect(outcome).toEqual({ ok: true, warnings: [{ event: 'assistant.ask_folder_unavailable', message: expect.any(String) }] });
    expect(off.extension.askFolder()).toBeUndefined();
    expect(off.extension.assistantSettings()).toBeDefined();
    const on = counted({ summary: false, assistant: false });
    expect((await on.extension.configure?.({ preview: true }, missing, CONTEXT))?.ok).toBe(false);
  });

  it.each([
    ['a folder whose intents file is not JSON', { text: 'not json at all SENTINEL-CONTENT' }],
    ['a folder with a query that writes', { text: JSON.stringify({ wipe: { parameters: [], query: "MATCH (n) WHERE n.x = 'SENTINEL-CONTENT' DETACH DELETE n" } }) }],
  ])('treats %s as unusable: Ask off starts the assistant without a folder and a warning that holds no content, Ask on refuses the start', async (_name, content) => {
    const folder = makeAskFolder(CONTEXT.sourceIds);
    writeFileSync(join(folder, 'source-a', 'intents.json'), content.text);
    const env = { ...ENV, NEBURYX_ASK_MAPPING_FOLDER: folder };
    const off = counted({ ask: false, summary: false });
    const outcome = await off.extension.configure?.({ preview: true }, env, CONTEXT);
    expect(outcome).toEqual({ ok: true, warnings: [{ event: 'assistant.ask_folder_unavailable', message: expect.any(String) }] });
    expect(JSON.stringify(outcome)).not.toContain('SENTINEL-CONTENT');
    expect(off.extension.askFolder()).toBeUndefined();
    const on = counted({ summary: false, assistant: false });
    const refused = await on.extension.configure?.({ preview: true }, env, CONTEXT);
    expect(refused?.ok).toBe(false);
    expect(on.extension.askFolder()).toBeUndefined();
  });

  it('reads the assistant settings and instructions at configure, and holds them frozen with the hash', async () => {
    const { extension } = counted();
    expect((await extension.configure?.({ preview: true }, ENV, CONTEXT))?.ok).toBe(true);
    expect(extension.assistantSettings()).toMatchObject({ maxSteps: 4, contextTurns: 3 });
    expect(Object.isFrozen(extension.assistantSettings())).toBe(true);
    expect(extension.assistantInstructions()?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stops configure naming an assistant setting that is bad, and never its value, and reads none with the assistant off', async () => {
    const bad = { ...ENV, NEBURYX_ASSISTANT_MAX_STEPS: 'SENTINEL-STEPS', NEBURYX_ASSISTANT_PROMPT_FILE: '/not/there.md' };
    const on = counted();
    const outcome = await on.extension.configure?.({ preview: true }, bad, CONTEXT);
    expect(outcome?.ok).toBe(false);
    const problems = outcome?.ok === false ? outcome.problems.join(' ') : '';
    expect(problems).toContain('NEBURYX_ASSISTANT_MAX_STEPS');
    expect(problems).toContain('NEBURYX_ASSISTANT_PROMPT_FILE');
    expect(problems).not.toContain('SENTINEL');
    const off = counted({ assistant: false });
    expect((await off.extension.configure?.({ preview: true }, bad, CONTEXT))?.ok).toBe(true);
    expect([off.extension.assistantSettings(), off.extension.assistantInstructions()]).toEqual([undefined, undefined]);
  });
});
