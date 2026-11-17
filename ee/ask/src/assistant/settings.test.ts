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
    expect(settingsOf()).toEqual({ model: 'claude-sonnet-5-5', timeoutMs: 60_000, totalTimeoutMs: 180_000, maxCalls: 5, maxSteps: 4, contextTurns: 3, maxMessageWords: 1000, maxInputTokens: 25_000, maxOutputTokens: 4000 });
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
    });
    expect(settings).toEqual({ model: 'claude-haiku-5-5', timeoutMs: 30_000, totalTimeoutMs: 90_000, maxCalls: 3, maxSteps: 2, maxRows: 40, contextTurns: 5, maxMessageWords: 500, maxInputTokens: 10_000, maxOutputTokens: 2000 });
    expect(settingsOf({ [ASSISTANT_VARIABLES.maxCalls]: '' }).maxCalls).toBe(5);
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
