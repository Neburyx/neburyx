import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AI_LIMITS, SUMMARY_DEFAULTS } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { configureAsk } from '../configure.js';
import { createEnterpriseExtension } from '../index.js';
import { makeAskFolder, removeAskFolders } from '../testing/ask-folder.js';
import { readSummarySettings, summaryAvailability } from './settings.js';

afterAll(removeAskFolders);

const SENTINEL = '987654321987654321sentinel';
const problemsOf = (env: Record<string, string | undefined>): readonly string[] => {
  const read = readSummarySettings(env);
  return read.ok ? [] : read.problems;
};

describe('the summary settings', () => {
  it('are the defaults when nothing is set', () => {
    const read = readSummarySettings({});
    expect(read).toEqual({
      ok: true,
      settings: { model: 'claude-sonnet-5-5', timeoutMs: 60_000, totalTimeoutMs: 180_000, maxCalls: 5, maxElements: 300, maxOutputTokens: 4000, maxInputTokens: 25_000, retentionDays: 30 },
    });
    expect(SUMMARY_DEFAULTS.maxCalls).toBe(5);
  });

  it('take each valid value, and an empty value counts as not set', () => {
    const read = readSummarySettings({
      NEBURYX_SUMMARY_MODEL: 'claude-opus-5-5',
      NEBURYX_SUMMARY_TIMEOUT_MS: '90000',
      NEBURYX_SUMMARY_TOTAL_TIMEOUT_MS: '240000',
      NEBURYX_SUMMARY_MAX_CALLS: '3',
      NEBURYX_SUMMARY_MAX_ELEMENTS: '150',
      NEBURYX_SUMMARY_MAX_OUTPUT_TOKENS: '8000',
      NEBURYX_SUMMARY_MAX_INPUT_TOKENS: '40000',
      NEBURYX_SUMMARY_RUN_RETENTION_DAYS: '7',
    });
    expect(read).toEqual({ ok: true, settings: { model: 'claude-opus-5-5', timeoutMs: 90_000, totalTimeoutMs: 240_000, maxCalls: 3, maxElements: 150, maxOutputTokens: 8000, maxInputTokens: 40_000, retentionDays: 7 } });
    expect(readSummarySettings({ NEBURYX_SUMMARY_MODEL: '', NEBURYX_SUMMARY_MAX_CALLS: '' })).toMatchObject({ ok: true, settings: { model: 'claude-sonnet-5-5', maxCalls: 5 } });
  });

  it.each(['NEBURYX_SUMMARY_TIMEOUT_MS', 'NEBURYX_SUMMARY_TOTAL_TIMEOUT_MS'])('refuses %s outside the range of Ask timeout without echoing the value', (name) => {
    for (const bad of ['999', '600001', 'abc', '1.5', '-5', `${SENTINEL}`]) {
      const problems = problemsOf({ [name]: bad });
      expect(problems).toEqual([`${name} must be a whole number from ${AI_LIMITS.timeoutMs.min} to ${AI_LIMITS.timeoutMs.max}`]);
      expect(problems.join()).not.toContain(bad);
    }
  });

  it('refuses an output limit outside 1,000 to 32,000 tokens without echoing the value, and takes the two ends', () => {
    for (const bad of ['999', '32001', 'abc', '1.5', '-5', SENTINEL]) {
      const problems = problemsOf({ NEBURYX_SUMMARY_MAX_OUTPUT_TOKENS: bad });
      expect(problems).toEqual(['NEBURYX_SUMMARY_MAX_OUTPUT_TOKENS must be a whole number from 1000 to 32000']);
      expect(problems.join()).not.toContain(bad);
    }
    expect(readSummarySettings({ NEBURYX_SUMMARY_MAX_OUTPUT_TOKENS: '1000' })).toMatchObject({ ok: true, settings: { maxOutputTokens: 1000 } });
    expect(readSummarySettings({ NEBURYX_SUMMARY_MAX_OUTPUT_TOKENS: '32000' })).toMatchObject({ ok: true, settings: { maxOutputTokens: 32_000 } });
  });

  it.each(['NEBURYX_SUMMARY_MAX_CALLS', 'NEBURYX_SUMMARY_MAX_ELEMENTS', 'NEBURYX_SUMMARY_MAX_INPUT_TOKENS', 'NEBURYX_SUMMARY_RUN_RETENTION_DAYS'])('refuses %s that is not a positive whole number', (name) => {
    for (const bad of ['0', '-1', '2.5', 'many', '1e3', SENTINEL, '99999999999999999999']) {
      const problems = problemsOf({ [name]: bad });
      expect(problems).toEqual([`${name} must be a positive whole number`]);
      expect(problems.join()).not.toContain(SENTINEL);
    }
  });

  it('reports every bad value at once', () => {
    expect(problemsOf({ NEBURYX_SUMMARY_MAX_CALLS: '0', NEBURYX_SUMMARY_TIMEOUT_MS: 'x' })).toHaveLength(2);
  });
});

describe('the availability of the summary', () => {
  const settings = { model: 'm', timeoutMs: 1, totalTimeoutMs: 2, maxCalls: 1, maxElements: 1, maxOutputTokens: 1000, maxInputTokens: 1000, retentionDays: 1 };

  it('is available with Ask configured, the settings read and the token key set', () => {
    expect(summaryAvailability({ askConfigured: true, settings, tokenKeyConfigured: true })).toEqual({ available: true });
  });

  it('names the token key file when it is not set', () => {
    expect(summaryAvailability({ askConfigured: true, settings, tokenKeyConfigured: false })).toEqual({ available: false, reason: 'NEBURYX_SUMMARY_TOKEN_KEY_FILE is not set' });
  });

  it('is unavailable when Ask is not configured or no settings were read', () => {
    expect(summaryAvailability({ askConfigured: false, settings, tokenKeyConfigured: true }).available).toBe(false);
    expect(summaryAvailability({ askConfigured: true, settings: undefined, tokenKeyConfigured: true }).available).toBe(false);
  });
});

const askEnv = (folder: string, extra: Record<string, string | undefined> = {}) => ({ NEBURYX_ASK_API_KEY: 'SENTINEL-KEY-VALUE', NEBURYX_ASK_MAPPING_FOLDER: folder, ...extra });
const CONTEXT = { sourceIds: ['s1'] };

const keyDirectory = mkdtempSync(join(tmpdir(), 'case-summary-settings-key-'));
afterAll(() => rmSync(keyDirectory, { recursive: true, force: true }));
function keyFile(): string {
  const path = join(keyDirectory, 'key');
  writeFileSync(path, 'ab'.repeat(32), { mode: 0o600 });
  return path;
}

describe('the summary settings in the extension', () => {
  it('are held, with the shipped size guard, and the summary unavailable until the token key is set', async () => {
    const extension = createEnterpriseExtension();
    expect(extension.summaryAvailability().available).toBe(false);
    expect(await extension.configure?.({}, askEnv(makeAskFolder(['s1'])), CONTEXT)).toEqual({ ok: true });
    expect(extension.summarySettings()).toMatchObject({ maxCalls: 5, maxElements: 300, maxInputTokens: 25_000 });
    expect(extension.summaryAvailability()).toEqual({ available: false, reason: 'NEBURYX_SUMMARY_TOKEN_KEY_FILE is not set' });
  });

  it('make the summary available with the token key, and take the size guard the operator sets', async () => {
    const extension = createEnterpriseExtension();
    await extension.configure?.({}, askEnv(makeAskFolder(['s1']), { NEBURYX_SUMMARY_MAX_INPUT_TOKENS: '50000', NEBURYX_SUMMARY_TOKEN_KEY_FILE: keyFile() }), CONTEXT);
    expect(extension.summaryAvailability()).toEqual({ available: true });
    expect(extension.summarySettings()?.maxInputTokens).toBe(50_000);
  });

  it('refuse start-up on a bad summary value, naming the variable and never the value', async () => {
    const extension = createEnterpriseExtension();
    const outcome = await extension.configure?.({}, askEnv(makeAskFolder(['s1']), { NEBURYX_SUMMARY_MAX_CALLS: SENTINEL }), CONTEXT);
    expect(outcome).toEqual({ ok: false, problems: ['NEBURYX_SUMMARY_MAX_CALLS must be a positive whole number'] });
    expect(extension.summaryAvailability().available).toBe(false);
  });

  it('still stop start-up when a shared Ask setting is bad, and read no summary setting', async () => {
    const extension = createEnterpriseExtension();
    const outcome = await extension.configure?.({}, { NEBURYX_SUMMARY_MAX_CALLS: '0' }, CONTEXT);
    expect(outcome?.ok).toBe(false);
    if (outcome !== undefined && !outcome.ok) expect(outcome.problems.join()).not.toContain('NEBURYX_SUMMARY');
    expect(extension.summarySettings()).toBeUndefined();
  });

  it('are independent of Ask variables in both directions', async () => {
    const folder = makeAskFolder(['s1']);
    const withAsk = askEnv(folder, { NEBURYX_ASK_TIMEOUT_MS: '5000', NEBURYX_ASK_MAX_RETRIES: '3', NEBURYX_ASK_MAX_TOKENS: '100', NEBURYX_ASK_CLASSIFICATION_MODEL: 'other-model' });
    expect(readSummarySettings(withAsk)).toEqual(readSummarySettings({}));
    const withSummary = askEnv(folder, { NEBURYX_SUMMARY_TIMEOUT_MS: '5000', NEBURYX_SUMMARY_MODEL: 'other-model', NEBURYX_SUMMARY_MAX_CALLS: '2' });
    const plain = await configureAsk(askEnv(folder));
    const changed = await configureAsk(withSummary);
    expect(changed.configuration).toEqual(plain.configuration);
  });
});
