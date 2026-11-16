import type { GraphNode, SummaryReading } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { promptRecordOf, type ModelProvider, type ModelRequest } from '../provider.js';
import { SUMMARY_DEFAULTS } from '@neburyx/contracts';
import type { ReplyObservation } from '../case-summary/summarizer.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { liveSummaryProvider, LiveProviderError } from './live.js';
import { budgetedProvider, evalSummarizer, scriptedSummaryProvider, summaryRunSettings } from './summary.js';

const node = (id: string): GraphNode => ({ ref: { sourceId: 'demo', entityType: 'item', stableId: id }, display: { title: id, type: 'item' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
const view: SummaryReading = { nodes: [node('AC-1'), node('AC-2')], edges: [], unresolved: 0, omitted: false, notRetrieved: { value: 0, quality: 'exact', scope: 'coverage' }, uncounted: 0 };
const REQUEST: ModelRequest = { promptId: 'p', version: 1, instructions: 'i', values: 'v' };
const GOOD = JSON.stringify({ sentences: [{ text: 'AC-1 is listed.', cites: ['n1'] }] });

describe('the settings of a summary run', () => {
  it('are the product\'s own settings, with no size guard until the environment gives one, and a problem names the variable and not its value', () => {
    const settings = summaryRunSettings({ NEBURYX_SUMMARY_MAX_INPUT_TOKENS: '50000' });
    expect(settings).toMatchObject({ ok: true, settings: { maxCalls: SUMMARY_DEFAULTS.maxCalls, maxInputTokens: 50_000 } });
    expect(summaryRunSettings({})).toMatchObject({ ok: true, settings: { maxCalls: SUMMARY_DEFAULTS.maxCalls } });
    const bad = summaryRunSettings({ NEBURYX_SUMMARY_MAX_INPUT_TOKENS: 'SENTINEL-VALUE' });
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).toContain('NEBURYX_SUMMARY_MAX_INPUT_TOKENS');
    expect(JSON.stringify(bad)).not.toContain('SENTINEL-VALUE');
  });
});

describe('the scripted provider', () => {
  it('answers each request with the reply a function gives for its values, with no key and no network', async () => {
    const provider = scriptedSummaryProvider((values) => `reply for ${values}`);
    expect(await provider.complete(REQUEST, new AbortController().signal)).toMatchObject({ status: 'ok', text: 'reply for v' });
  });
});

describe('the budgeted provider', () => {
  const inner: ModelProvider = { complete: async (request) => ({ status: 'ok', text: GOOD, usage: { kind: 'known', inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 }, model: 'm', prompt: promptRecordOf(request) }) };

  it('makes the nth request and refuses the (n+1)th without making it, and counts what was made', async () => {
    const budgeted = budgetedProvider(inner, 2);
    const signal = new AbortController().signal;
    expect((await budgeted.provider.complete(REQUEST, signal)).status).toBe('ok');
    expect((await budgeted.provider.complete(REQUEST, signal)).status).toBe('ok');
    expect(await budgeted.provider.complete(REQUEST, signal)).toMatchObject({ status: 'failed', code: 'provider-error' });
    expect(budgeted.usage()).toEqual({ calls: 2, refused: 1, failed: 0, inputTokens: 20, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 0, withoutCounts: 0 });
  });

  it('counts a call whose answer states no token counts, and a failed call, and retries nothing', async () => {
    let asked = 0;
    const failing: ModelProvider = { complete: async (request) => (asked++, { status: 'failed', code: 'rate-limited', prompt: promptRecordOf(request) }) };
    const budgeted = budgetedProvider(failing, 3);
    await budgeted.provider.complete(REQUEST, new AbortController().signal);
    expect(asked).toBe(1);
    expect(budgeted.usage()).toMatchObject({ calls: 1, failed: 1, withoutCounts: 1 });
  });
});

describe('the summarizer of the evaluation', () => {
  const settings = { model: 'claude-sonnet-5-5', timeoutMs: 60_000, totalTimeoutMs: 180_000, maxCalls: 5, maxElements: 300, maxInputTokens: 100_000, retentionDays: 30 };

  it('is the product\'s own summarizer over the provider it is given, reports the calls of a click and tells its observer what the checks did', async () => {
    const seen: ReplyObservation[] = [];
    const built = await evalSummarizer({ provider: scriptedSummaryProvider(() => GOOD), settings, env: {}, observe: (observation) => void seen.push(observation) });
    if (!built.ok) throw new Error(built.problems.join('; '));
    const run = await built.summarizer.summarize(view, new AbortController().signal);
    expect(run.outcome.status).toBe('ok');
    expect(run.calls).toBe(1);
    expect(seen).toHaveLength(1);
    expect(built.summarizer.instructionsSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(built.summarizer.instructions).toContain('# Reply format');
  });

  it('refuses a replacement file that cannot be read, naming the setting and no path', async () => {
    const built = await evalSummarizer({ provider: scriptedSummaryProvider(() => GOOD), settings, env: { NEBURYX_SUMMARY_TYPOLOGY_FILE: '/nonexistent/typology.md' }, observe: () => undefined });
    expect(built.ok).toBe(false);
    expect(JSON.stringify(built)).toContain('NEBURYX_SUMMARY_TYPOLOGY_FILE');
    expect(JSON.stringify(built)).not.toContain('/nonexistent');
  });
});

describe('the live provider of a summary run', () => {
  const made: string[] = [];
  afterAll(() => made.forEach((root) => rmSync(root, { recursive: true, force: true })));
  const folder = '/somewhere/absolute';
  const settings = { model: 'claude-sonnet-5-5', timeoutMs: 60_000, totalTimeoutMs: 180_000, maxCalls: 5, maxElements: 300, maxInputTokens: 100_000, retentionDays: 30 };
  const keyFile = (mode: number): string => {
    const root = mkdtempSync(join(tmpdir(), 'summary-eval-key-'));
    made.push(root);
    const key = join(root, 'key');
    writeFileSync(key, 'sk-test-not-a-real-key\n', { mode });
    return key;
  };

  it('refuses a key in the environment, a key file others can read, and a missing key, before any call and without a key in the message', async () => {
    await expect(liveSummaryProvider({ NEBURYX_ASK_API_KEY: 'SENTINEL-KEY-VALUE' }, folder, settings)).rejects.toThrow(LiveProviderError);
    await expect(liveSummaryProvider({ NEBURYX_ASK_API_KEY: 'SENTINEL-KEY-VALUE' }, folder, settings)).rejects.not.toThrow('SENTINEL-KEY-VALUE');
    await expect(liveSummaryProvider({ NEBURYX_ASK_API_KEY_FILE: keyFile(0o644) }, folder, settings)).rejects.toThrow(LiveProviderError);
    await expect(liveSummaryProvider({}, folder, settings)).rejects.toThrow(/KEY/);
  });

  it('reads the key from its file only, uses the summary\'s own model, forces retries to 0 whatever Ask is set to, and carries the cache switch', async () => {
    const built = await liveSummaryProvider({ NEBURYX_ASK_API_KEY_FILE: keyFile(0o600), NEBURYX_ASK_MAX_RETRIES: '3', NEBURYX_AI_CACHE: 'off', ANTHROPIC_API_KEY: 'ignored' }, folder, settings);
    expect(built).toMatchObject({ model: 'claude-sonnet-5-5', maxRetries: 0, cacheEnabled: false });
    const on = await liveSummaryProvider({ NEBURYX_ASK_API_KEY_FILE: keyFile(0o600) }, folder, settings);
    expect(on.cacheEnabled).toBe(true);
  });
});
