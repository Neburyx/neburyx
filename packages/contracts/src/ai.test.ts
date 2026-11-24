import { describe, expect, it } from 'vitest';
import { AI_LIMITS, AI_MOVED_KEYS, SUMMARY_DEFAULTS, aiSettingsSchema, aiStatusResponseSchema } from './ai.js';

const messageOf = (value: unknown): string => {
  const result = aiSettingsSchema.safeParse(value);
  return result.success ? '' : result.error.issues.map((issue) => issue.message).join('; ');
};

describe('the ai settings of the mapping file', () => {
  it('hold the preview switch only', () => {
    expect(aiSettingsSchema.safeParse({ preview: true }).success).toBe(true);
    expect(aiSettingsSchema.safeParse({}).success).toBe(true);
    expect(aiSettingsSchema.safeParse({ preview: 'yes' }).success).toBe(false);
  });

  it.each(Object.entries(AI_MOVED_KEYS))('refuse the key %s and name the variable that replaces it', (key, variable) => {
    const message = messageOf({ preview: true, [key]: 'x' });
    expect(message).toContain(`ai.${key}`);
    expect(message).toContain(variable);
  });

  it.each(['prompts', 'properties', 'pii_override', 'anything_else'])('refuse the key %s as not a setting', (key) => {
    expect(messageOf({ [key]: {} })).toBe(`ai.${key} is not a setting`);
  });

  it('never repeat a value of a refused key', () => {
    expect(messageOf({ key: { env: 'SECRET-VALUE-123' } })).not.toContain('SECRET-VALUE-123');
  });
});

describe('the case summary defaults', () => {
  it('are the agreed ones, inside the range Ask uses for a timeout', () => {
    expect(SUMMARY_DEFAULTS).toEqual({ model: 'claude-sonnet-5-5', timeoutMs: 60_000, totalTimeoutMs: 180_000, maxCalls: 5, maxElements: 300, maxOutputTokens: 4000, maxInputTokens: 25_000, retentionDays: 30 });
    expect(SUMMARY_DEFAULTS.timeoutMs).toBeGreaterThanOrEqual(AI_LIMITS.timeoutMs.min);
    expect(SUMMARY_DEFAULTS.totalTimeoutMs).toBeLessThanOrEqual(AI_LIMITS.timeoutMs.max);
  });
});

describe('the status of the AI features', () => {
  const all = { ask: { available: true }, summary: { available: false }, assistant: { available: false } };

  it('holds one boolean for each of the three features', () => {
    expect(aiStatusResponseSchema.parse(all)).toEqual(all);
  });

  it('carries the Assistant model when available and none when unavailable', () => {
    const available = { ...all, assistant: { available: true, messageWords: 1000, model: 'claude-sonnet-5-5' } };
    expect(aiStatusResponseSchema.parse(available)).toEqual(available);
    expect(aiStatusResponseSchema.safeParse(all).success).toBe(true);
  });

  it.each([['an available assistant without the model', { ...all, assistant: { available: true, messageWords: 1000 } }], ['an available assistant with an empty model', { ...all, assistant: { available: true, messageWords: 1000, model: '' } }], ['an unavailable assistant with a model', { ...all, assistant: { available: false, model: 'm' } }], ['an unknown field of an available assistant', { ...all, assistant: { available: true, messageWords: 1000, model: 'm', key: 'k' } }]])('refuses %s', (_label, value) => {
    expect(aiStatusResponseSchema.safeParse(value).success).toBe(false);
  });

  it.each([['an unknown feature', { ...all, other: { available: true } }], ['a missing feature', { ask: { available: true }, summary: { available: true } }], ['an unknown field of a feature', { ...all, ask: { available: true, reason: 'x' } }], ['a value that is not a boolean', { ...all, ask: { available: 'yes' } }], ['the old shape', { preview: true }]])('refuses %s', (_label, value) => {
    expect(aiStatusResponseSchema.safeParse(value).success).toBe(false);
  });
});
