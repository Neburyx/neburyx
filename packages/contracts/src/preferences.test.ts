import { describe, expect, it } from 'vitest';
import { preferencesResponseSchema, preferencesWriteRequestSchema } from './preferences.js';

describe('the preferences of a user', () => {
  it.each([[{}], [{ tour: 'completed' }], [{ tour: 'skipped' }]])('accepts %j as a write and as an answer', (preferences) => {
    expect(preferencesWriteRequestSchema.parse({ preferences })).toEqual({ preferences });
    expect(preferencesResponseSchema.parse({ preferences })).toEqual({ preferences });
  });

  it.each([
    ['a key that is not in the list', { preferences: { density: 'compact' } }],
    ['a value that is not allowed for the tour', { preferences: { tour: 'seen' } }],
    ['a value of another type', { preferences: { tour: true } }],
    ['an extra field beside preferences', { preferences: {}, other: 1 }],
    ['no preferences', {}],
    ['preferences that are not an object', { preferences: 'tour' }],
    ['a null value', { preferences: { tour: null } }],
  ])('refuses %s', (_name, body) => {
    expect(preferencesWriteRequestSchema.safeParse(body).success).toBe(false);
  });
});
