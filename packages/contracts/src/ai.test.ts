import { describe, expect, it } from 'vitest';
import { aiSettingsSchema } from './ai.js';

describe('the ai settings', () => {
  it('take the settings that are kept', () => {
    expect(aiSettingsSchema.safeParse({ preview: true, model: 'm', timeout_ms: 30000, cache: { enabled: true } }).success).toBe(true);
    expect(aiSettingsSchema.safeParse({}).success).toBe(true);
  });

  it.each(['prompts', 'properties', 'pii_override'])('refuse the old key %s', (key) => {
    expect(aiSettingsSchema.safeParse({ [key]: {} }).success).toBe(false);
    expect(aiSettingsSchema.safeParse({ preview: true, [key]: [] }).success).toBe(false);
  });
});
