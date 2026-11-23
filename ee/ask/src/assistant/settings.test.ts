import { describe, expect, it } from 'vitest';
import { ASSISTANT_VARIABLES, readAssistantSettings, rowsAllowed } from './settings.js';

const read = (env: Record<string, string | undefined> = {}) => readAssistantSettings(env);
const settingsOf = (env: Record<string, string | undefined> = {}) => {
  const result = read(env);
  if (!result.ok) throw new Error(result.problems.join('; '));
  return result.settings;
};

describe('the assistant settings by environment', () => {
  it('have the default of each setting when none is given', () => {
    expect(settingsOf()).toEqual({ model: 'claude-sonnet-5-5', timeoutMs: 60_000, totalTimeoutMs: 180_000, maxCalls: 7, maxSteps: 4, contextTurns: 3, maxMessageWords: 1000, maxInputTokens: 25_000, maxOutputTokens: 4000, runRetentionDays: 30, threadRetention: 'close', threadReadTurns: 100 });
  });

  it('take a value of every setting, and treat an empty value as not given', () => {
    const settings = settingsOf({
      [ASSISTANT_VARIABLES.model]: 'claude-haiku-5-5',
      [ASSISTANT_VARIABLES.timeoutMs]: '30000',
      [ASSISTANT_VARIABLES.totalTimeoutMs]: '90000',
      [ASSISTANT_VARIABLES.maxCalls]: '3',
      [ASSISTANT_VARIABLES.maxSteps]: '2',
      [ASSISTANT_VARIABLES.maxRows]: '40',
      [ASSISTANT_VARIABLES.contextTurns]: '5',
      [ASSISTANT_VARIABLES.maxMessageWords]: '500',
      [ASSISTANT_VARIABLES.maxInputTokens]: '10000',
      [ASSISTANT_VARIABLES.maxOutputTokens]: '2000',
      [ASSISTANT_VARIABLES.runRetentionDays]: '7',
      [ASSISTANT_VARIABLES.threadReadTurns]: '20',
    });
    expect(settings).toEqual({ model: 'claude-haiku-5-5', timeoutMs: 30_000, totalTimeoutMs: 90_000, maxCalls: 3, maxSteps: 2, maxRows: 40, contextTurns: 5, maxMessageWords: 500, maxInputTokens: 10_000, maxOutputTokens: 2000, runRetentionDays: 7, threadRetention: 'close', threadReadTurns: 20 });
    expect(settingsOf({ [ASSISTANT_VARIABLES.maxCalls]: '' }).maxCalls).toBe(7);
  });

  it.each([
    ['maxCalls', 10],
    ['maxSteps', 8],
    ['contextTurns', 6],
    ['maxMessageWords', 3000],
    ['maxInputTokens', 100_000],
    ['maxOutputTokens', 32_000],
    ['totalTimeoutMs', 600_000],
  ] as const)('accept the ceiling of %s and refuse one above it, naming the setting and never the value', (key, ceiling) => {
    const name = ASSISTANT_VARIABLES[key];
    expect(read({ [name]: String(ceiling) }).ok).toBe(true);
    const over = read({ [name]: String(ceiling + 1) });
    expect(over.ok).toBe(false);
    expect(over.ok ? '' : over.problems.join(' ')).toContain(name);
    expect(JSON.stringify(over)).not.toContain(String(ceiling + 1));
  });

  it.each(['0', '-1', '1.5', 'many', ' 3', '3 '])('refuse %j for a whole-number setting, naming it', (value) => {
    const result = read({ [ASSISTANT_VARIABLES.maxSteps]: value });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.problems.join(' ')).toContain(ASSISTANT_VARIABLES.maxSteps);
  });

  it('refuse a rows figure that is not a positive whole number, and accept any positive one', () => {
    expect(read({ [ASSISTANT_VARIABLES.maxRows]: '0' }).ok).toBe(false);
    expect(read({ [ASSISTANT_VARIABLES.maxRows]: 'x' }).ok).toBe(false);
    expect(read({ [ASSISTANT_VARIABLES.maxRows]: '1000000' }).ok).toBe(true);
  });

  it('refuse a per-call timeout above the total of the turn, naming the per-call setting', () => {
    const result = read({ [ASSISTANT_VARIABLES.timeoutMs]: '120000', [ASSISTANT_VARIABLES.totalTimeoutMs]: '60000' });
    expect(result).toEqual({ ok: false, problems: [`${ASSISTANT_VARIABLES.timeoutMs} must not be above ${ASSISTANT_VARIABLES.totalTimeoutMs}`] });
  });

  it('report every problem at once, never a value', () => {
    const result = read({ [ASSISTANT_VARIABLES.maxCalls]: 'SENTINEL-ONE', [ASSISTANT_VARIABLES.maxSteps]: 'SENTINEL-TWO' });
    expect(result.ok ? [] : result.problems).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
  });

  it('give one frozen object that no caller can change', () => {
    const settings = settingsOf();
    expect(Object.isFrozen(settings)).toBe(true);
  });
});

describe('the rows a turn may read', () => {
  it('are the source\'s page limit times the steps, and lower only when the operator says so', () => {
    expect(rowsAllowed(settingsOf(), 50)).toBe(200);
    expect(rowsAllowed(settingsOf({ [ASSISTANT_VARIABLES.maxRows]: '120' }), 50)).toBe(120);
    expect(rowsAllowed(settingsOf({ [ASSISTANT_VARIABLES.maxRows]: '5000' }), 50)).toBe(200);
    expect(rowsAllowed(settingsOf({ [ASSISTANT_VARIABLES.maxSteps]: '2' }), 25)).toBe(50);
  });
});

describe('the retention of the stored turn runs', () => {
  it('is 30 days when not given, and a positive whole number when given', () => {
    expect(settingsOf().runRetentionDays).toBe(30);
    expect(settingsOf({ [ASSISTANT_VARIABLES.runRetentionDays]: '1' }).runRetentionDays).toBe(1);
    expect(settingsOf({ [ASSISTANT_VARIABLES.runRetentionDays]: '' }).runRetentionDays).toBe(30);
  });

  it.each(['0', '-1', '1.5', '30d', 'abc', '99999999999999999999'])('stops the start for %s and names the setting, not the value', (value) => {
    const result = read({ [ASSISTANT_VARIABLES.runRetentionDays]: value });
    expect(result).toEqual({ ok: false, problems: [`${ASSISTANT_VARIABLES.runRetentionDays} must be a positive whole number`] });
  });
});

describe('the retention of the threads', () => {
  it('is `close` when not given, and when given as close', () => {
    expect(settingsOf().threadRetention).toBe('close');
    expect(settingsOf({ [ASSISTANT_VARIABLES.threadRetention]: 'close' }).threadRetention).toBe('close');
    expect(settingsOf({ [ASSISTANT_VARIABLES.threadRetention]: '' }).threadRetention).toBe('close');
  });

  it.each(['keep', 'forever', '30', 'Close', 'close '])('stops the start for %s and names the setting, not the value', (value) => {
    expect(read({ [ASSISTANT_VARIABLES.threadRetention]: value })).toEqual({ ok: false, problems: [`${ASSISTANT_VARIABLES.threadRetention} must be close`] });
  });
});

describe('how many turns of a thread one read gives', () => {
  it('is 100 when not given, and a whole number from 1 to 500 when given', () => {
    expect(settingsOf().threadReadTurns).toBe(100);
    expect(settingsOf({ [ASSISTANT_VARIABLES.threadReadTurns]: '1' }).threadReadTurns).toBe(1);
    expect(settingsOf({ [ASSISTANT_VARIABLES.threadReadTurns]: '500' }).threadReadTurns).toBe(500);
  });

  it.each(['0', '501', '-1', '1.5', 'many'])('stops the start for %s and names the setting, not the value', (value) => {
    const result = read({ [ASSISTANT_VARIABLES.threadReadTurns]: value });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain(ASSISTANT_VARIABLES.threadReadTurns);
    expect(JSON.stringify(result)).not.toContain(`"${value}"`);
  });
});
