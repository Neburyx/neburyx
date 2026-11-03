import { describe, expect, it } from 'vitest';
import { source } from '../test-utils.js';
import { currentSource, showsSyntheticBadge } from './current-source.js';

describe('currentSource', () => {
  it('is the bound source when there is one, whatever the number of sources', () => {
    expect(currentSource([source('a'), source('b')], 'b')).toMatchObject({ kind: 'bound', source: { id: 'b' } });
  });

  it('is the bound id with an unknown source when the list does not hold it', () => {
    expect(currentSource([source('a')], 'z')).toEqual({ kind: 'bound-unknown', sourceId: 'z' });
  });

  it('is the only source when exactly one is configured and none is bound', () => {
    expect(currentSource([source('a')], null)).toMatchObject({ kind: 'only', source: { id: 'a' } });
  });

  it('is a summary of the list, counting the connected ones, when several are configured and none is bound', () => {
    expect(currentSource([source('a'), source('b', { state: 'unavailable' }), source('c', { state: 'degraded' })], null)).toEqual({ kind: 'summary', total: 3, connected: 1 });
  });

  it('is none for an empty list', () => {
    expect(currentSource([], null)).toEqual({ kind: 'none' });
  });
});

describe('showsSyntheticBadge', () => {
  const real = source('real', { synthetic: false });
  const fake = source('fake', { synthetic: true });

  it('follows the flag of the bound source, and of the only source', () => {
    expect(showsSyntheticBadge(currentSource([fake, real], 'fake'), [fake, real])).toBe(true);
    expect(showsSyntheticBadge(currentSource([fake, real], 'real'), [fake, real])).toBe(false);
    expect(showsSyntheticBadge(currentSource([fake], null), [fake])).toBe(true);
    expect(showsSyntheticBadge(currentSource([real], null), [real])).toBe(false);
  });

  it('with several sources and none current, needs every one to be synthetic: a mix shows no badge', () => {
    expect(showsSyntheticBadge(currentSource([fake, source('b')], null), [fake, source('b')])).toBe(true);
    expect(showsSyntheticBadge(currentSource([fake, real], null), [fake, real])).toBe(false);
    expect(showsSyntheticBadge(currentSource([real, source('x', { synthetic: false })], null), [real])).toBe(false);
  });

  it('shows no badge for an empty list or for a bound source that is not in the list', () => {
    expect(showsSyntheticBadge(currentSource([], null), [])).toBe(false);
    expect(showsSyntheticBadge(currentSource([fake], 'missing'), [fake])).toBe(false);
  });
});
