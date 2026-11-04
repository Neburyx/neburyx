import type { SourceProfile } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { testProfile } from '../dev/test-profile.js';
import { createExcerpts } from './excerpts.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    settle = done;
  });
  return { promise, resolve: (value: T) => settle(value) };
}

const profileWith = (sourceId: string, mappingExcerpt: string): ApiResult<SourceProfile> => ({ ok: true, value: { ...testProfile(sourceId), mappingExcerpt } });

function setup(read: (sourceId: string) => Promise<ApiResult<SourceProfile>>) {
  const asked: string[] = [];
  const client = fakeClient({
    getProfile: (sourceId) => {
      asked.push(sourceId);
      return read(sourceId);
    },
  });
  return { excerpts: createExcerpts(client), asked };
}

describe('the mapping excerpts', () => {
  it('reads each source once in a visit, however often it is shown, and holds the text', async () => {
    const { excerpts, asked } = setup(async (id) => profileWith(id, `text of ${id}`));
    excerpts.show('a', 'visit-1');
    excerpts.show('a', 'visit-1');
    await settle();
    excerpts.show('a', 'visit-1');
    excerpts.show('b', 'visit-1');
    await settle();
    expect(asked).toEqual(['a', 'b']);
    expect(excerpts.getState().get('a')).toEqual({ opening: 'visit-1', loading: false, text: 'text of a' });
  });

  it('shows loading with no text on the first read', () => {
    const { excerpts } = setup(() => new Promise(() => undefined));
    excerpts.show('a', 'visit-1');
    expect(excerpts.getState().get('a')).toEqual({ opening: 'visit-1', loading: true });
  });

  it('reads again in the next visit, keeps the earlier text meanwhile and replaces it with the changed one', async () => {
    const second = deferred<ApiResult<SourceProfile>>();
    let reads = 0;
    const { excerpts } = setup((id) => (++reads === 1 ? Promise.resolve(profileWith(id, 'before')) : second.promise));
    excerpts.show('a', 'visit-1');
    await settle();
    excerpts.show('a', 'visit-2');
    expect(excerpts.getState().get('a')).toEqual({ opening: 'visit-2', loading: true, text: 'before' });
    second.resolve(profileWith('a', 'after'));
    await settle();
    expect(excerpts.getState().get('a')).toEqual({ opening: 'visit-2', loading: false, text: 'after' });
  });

  it('keeps the earlier text and shows the failure when a later read fails', async () => {
    let reads = 0;
    const { excerpts } = setup(async (id) => (++reads === 1 ? profileWith(id, 'before') : { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }));
    excerpts.show('a', 'visit-1');
    await settle();
    excerpts.show('a', 'visit-2');
    await settle();
    expect(excerpts.getState().get('a')).toEqual({ opening: 'visit-2', loading: false, text: 'before', failure: { code: 'NETWORK_UNAVAILABLE' } });
  });

  it('does not read a failed source again when it is shown again in the same visit, and reads it again for a retry', async () => {
    let reads = 0;
    const { excerpts, asked } = setup(async (id) => (++reads === 1 ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : profileWith(id, 'now')));
    excerpts.show('a', 'visit-1');
    await settle();
    excerpts.show('a', 'visit-1');
    await settle();
    expect(asked).toEqual(['a']);
    expect(excerpts.getState().get('a')).toEqual({ opening: 'visit-1', loading: false, failure: { code: 'NETWORK_UNAVAILABLE' } });
    excerpts.retry('a', 'visit-1');
    await settle();
    expect(excerpts.getState().get('a')).toEqual({ opening: 'visit-1', loading: false, text: 'now' });
  });

  it('never shows a profile that names another source, and says schema mismatch', async () => {
    const { excerpts } = setup(async () => profileWith('other', 'not mine'));
    excerpts.show('a', 'visit-1');
    await settle();
    expect(excerpts.getState().get('a')).toEqual({ opening: 'visit-1', loading: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it('keeps the answers of two sources apart whichever arrives first', async () => {
    const one = deferred<ApiResult<SourceProfile>>();
    const two = deferred<ApiResult<SourceProfile>>();
    const { excerpts } = setup((id) => (id === 'a' ? one.promise : two.promise));
    excerpts.show('a', 'visit-1');
    excerpts.show('b', 'visit-1');
    two.resolve(profileWith('b', 'text of b'));
    await settle();
    expect(excerpts.getState().get('a')?.text).toBeUndefined();
    one.resolve(profileWith('a', 'text of a'));
    await settle();
    expect([excerpts.getState().get('a')?.text, excerpts.getState().get('b')?.text]).toEqual(['text of a', 'text of b']);
  });

  it('gives an unexpected failure when the client throws, and ignores a retry while a read is going', async () => {
    const { excerpts, asked } = setup(() => Promise.reject(new Error('boom')));
    excerpts.show('a', 'visit-1');
    excerpts.retry('a', 'visit-1');
    await settle();
    expect(asked).toEqual(['a']);
    expect(excerpts.getState().get('a')).toMatchObject({ loading: false, failure: { code: 'UNEXPECTED_FAILURE' } });
  });

  it('gives an opening that asks while a read is going a read of its own when that one ends, and keeps the text of the first meanwhile', async () => {
    const first = deferred<ApiResult<SourceProfile>>();
    const second = deferred<ApiResult<SourceProfile>>();
    let reads = 0;
    const { excerpts, asked } = setup(() => (++reads === 1 ? first.promise : second.promise));
    excerpts.show('a', 'visit-1');
    excerpts.show('a', 'visit-2');
    expect(asked).toEqual(['a']);
    first.resolve(profileWith('a', 'first text'));
    await settle();
    expect(asked).toEqual(['a', 'a']);
    expect(excerpts.getState().get('a')).toEqual({ opening: 'visit-2', loading: true, text: 'first text' });
    second.resolve(profileWith('a', 'second text'));
    await settle();
    expect(excerpts.getState().get('a')).toEqual({ opening: 'visit-2', loading: false, text: 'second text' });
  });

  it('names each opening of the page differently', () => {
    const { excerpts } = setup(async (id) => profileWith(id, ''));
    expect(excerpts.newOpening()).not.toBe(excerpts.newOpening());
  });

  it('drops the failure of a read that was replaced by a newer opening, and keeps the earlier text', async () => {
    const first = deferred<ApiResult<SourceProfile>>();
    const second = deferred<ApiResult<SourceProfile>>();
    let reads = 0;
    const { excerpts } = setup(() => (++reads === 1 ? first.promise : second.promise));
    excerpts.show('a', 'visit-1');
    excerpts.show('a', 'visit-2');
    first.resolve({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } });
    await settle();
    expect(excerpts.getState().get('a')).toEqual({ opening: 'visit-2', loading: true });
    second.resolve(profileWith('a', 'text'));
    await settle();
    expect(excerpts.getState().get('a')).toEqual({ opening: 'visit-2', loading: false, text: 'text' });
  });
});
