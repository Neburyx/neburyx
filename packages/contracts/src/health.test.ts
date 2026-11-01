import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './health.js';

describe('healthResponseSchema', () => {
  it('accepts only the ok status and nothing else', () => {
    expect(healthResponseSchema.safeParse({ status: 'ok' }).success).toBe(true);
    for (const value of [{}, { status: 'up' }, { status: 'ok', host: 'db' }, 'ok']) {
      expect(healthResponseSchema.safeParse(value).success).toBe(false);
    }
  });
});
