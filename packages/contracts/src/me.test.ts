import { describe, expect, it } from 'vitest';
import { meResponseSchema } from './me.js';

const valid = {
  principal: { id: '0192f000-0000-7000-8000-000000000001', displayName: 'Local workspace', role: 'administrator' },
  edition: 'community',
  identityMode: 'none',
  sources: [],
};

describe('meResponseSchema', () => {
  it('accepts the local principal with no sources and one permitted source', () => {
    expect(meResponseSchema.safeParse(valid).success).toBe(true);
    expect(meResponseSchema.safeParse({ ...valid, sources: [{ sourceId: 'fincrime', viewSensitive: false, synthetic: true }] }).success).toBe(true);
  });

  it.each([
    ['an unknown edition', { ...valid, edition: 'free' }],
    ['an unknown identity mode', { ...valid, identityMode: 'password' }],
    ['an unknown role', { ...valid, principal: { ...valid.principal, role: 'unlisted' } }],
    ['an id that is not a UUID', { ...valid, principal: { ...valid.principal, id: 'local' } }],
    ['an empty display name', { ...valid, principal: { ...valid.principal, displayName: '' } }],
    ['a field it does not define', { ...valid, preferences: {} }],
    ['a source without its flags', { ...valid, sources: [{ sourceId: 'fincrime' }] }],
  ])('rejects %s', (_name, value) => {
    expect(meResponseSchema.safeParse(value).success).toBe(false);
  });
});
