import { describe, expect, it } from 'vitest';
import { profileFrom } from './profile.ts';

describe('the profile of a browser test run', () => {
  it('is the laptop unless the run asks for the runner by name', () => {
    expect(profileFrom({})).toBe('laptop');
    expect(profileFrom({ NEBURYX_UX_PROFILE: '' })).toBe('laptop');
    expect(profileFrom({ NEBURYX_UX_PROFILE: 'laptop' })).toBe('laptop');
    expect(profileFrom({ NEBURYX_UX_PROFILE: 'runner' })).toBe('runner');
  });

  it('is not changed by CI, set to anything, in the environment of a developer or of the runner', () => {
    for (const ci of ['true', 'false', '', '1', 'yes']) expect(profileFrom({ CI: ci })).toBe('laptop');
    expect(profileFrom({ CI: 'true', NEBURYX_UX_PROFILE: 'runner' })).toBe('runner');
  });

  it('refuses a name that is neither, rather than choosing one', () => {
    for (const value of ['Runner', 'ci', 'true', 'laptop ', 'looser']) expect(() => profileFrom({ NEBURYX_UX_PROFILE: value })).toThrow(/"laptop" or "runner"/);
  });
});
