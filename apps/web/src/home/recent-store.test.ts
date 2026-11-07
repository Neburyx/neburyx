import type { InvestigationListItem, InvestigationListResponse, SourceProfile } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { testProfile } from '../dev/test-profile.js';
import { investigationOf, listItemOf, listOf } from '../investigations/test-data.js';
import { createRecentInvestigations } from './recent-store.js';

const item = (id: number, sourceId: string): InvestigationListItem => listItemOf(investigationOf(`0192f000-0000-7000-8000-00000000010${id}`, sourceId, 'kind-a', `X-${id}`));
const answer = (...items: InvestigationListItem[]): ApiResult<InvestigationListResponse> => ({ ok: true, value: listOf(items) });
const down: ApiResult<never> = { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function counting(lists: ApiResult<InvestigationListResponse>[], profile: (sourceId: string) => ApiResult<SourceProfile> = (sourceId) => ({ ok: true, value: testProfile(sourceId) })) {
  const listCalls: number[] = [];
  const profileCalls: string[] = [];
  const reads = { lists: listCalls, profiles: profileCalls };
  const held: Array<(result: ApiResult<InvestigationListResponse>) => void> = [];
  const client = fakeClient({
    listInvestigations: (limit) => {
      reads.lists.push(limit);
      const next = lists.shift();
      return next === undefined ? new Promise((resolve) => held.push(resolve)) : Promise.resolve(next);
    },
    getProfile: async (sourceId) => {
      reads.profiles.push(sourceId);
      return profile(sourceId);
    },
  });
  return { client, reads, held };
}

describe('the recent investigations of the session', () => {
  it('reads the list the first time Home is visited, and once for the two effects of StrictMode', async () => {
    const { client, reads } = counting([answer()]);
    const recent = createRecentInvestigations(client);
    expect(reads.lists).toEqual([]);
    recent.ensure();
    recent.ensure();
    await settle();
    expect(reads.lists).toEqual([5]);
    expect(recent.getState().list).toEqual({ phase: 'ready', data: listOf([]) });
  });

  it('reads the list again at every later visit, keeps the earlier rows on screen until the new answer, and shows the new one', async () => {
    const first = item(1, 'a');
    const second = item(2, 'a');
    const { client, reads, held } = counting([answer(first)]);
    const recent = createRecentInvestigations(client);
    recent.ensure();
    await settle();
    recent.ensure();
    expect(recent.getState().list).toEqual({ phase: 'loading', data: listOf([first]) });
    held[0]?.(answer(second, first));
    await settle();
    expect(reads.lists).toHaveLength(2);
    expect(recent.getState().list).toMatchObject({ phase: 'ready', data: { items: [second, first] } });
    recent.ensure();
    expect(reads.lists).toHaveLength(3);
  });

  it('reads the profile of each distinct source among the rows once for each list read, and again at the next visit', async () => {
    const rows = answer(item(1, 'a'), item(2, 'a'), item(3, 'b'));
    const { client, reads } = counting([rows, rows]);
    const recent = createRecentInvestigations(client);
    recent.ensure();
    await settle();
    expect([...reads.profiles].sort()).toEqual(['a', 'b']);
    expect([...recent.getState().profiles.keys()].sort()).toEqual(['a', 'b']);
    expect(recent.getState().profiles.get('a')).toMatchObject({ phase: 'ready' });
    recent.ensure();
    await settle();
    expect([...reads.profiles].sort()).toEqual(['a', 'a', 'b', 'b']);
  });

  it('reads no profile for a source that has no row in the new list', async () => {
    const { client, reads } = counting([answer(item(1, 'a'), item(2, 'b')), answer(item(3, 'b'))]);
    const recent = createRecentInvestigations(client);
    recent.ensure();
    await settle();
    expect([...reads.profiles].sort()).toEqual(['a', 'b']);
    recent.ensure();
    await settle();
    expect([...reads.profiles].sort()).toEqual(['a', 'b', 'b']);
  });

  it('reads a profile that failed again at the next visit, and keeps the one that was read while it is read again', async () => {
    let failing = true;
    const rows = answer(item(1, 'a'));
    const { client, reads } = counting([rows, rows], (sourceId) => (failing ? down : { ok: true, value: testProfile(sourceId) }));
    const recent = createRecentInvestigations(client);
    recent.ensure();
    await settle();
    expect(recent.getState().profiles.get('a')).toMatchObject({ phase: 'failed' });
    failing = false;
    recent.ensure();
    await settle();
    expect(reads.profiles).toEqual(['a', 'a']);
    expect(recent.getState().profiles.get('a')).toMatchObject({ phase: 'ready' });
  });

  it('does not use a profile that names another source', async () => {
    const { client } = counting([answer(item(1, 'a'))], () => ({ ok: true, value: testProfile('other') }));
    const recent = createRecentInvestigations(client);
    recent.ensure();
    await settle();
    expect(recent.getState().profiles.get('a')).toEqual({ phase: 'failed', failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it('reads no profile when the list could not be read, shows the failure, and reads the list again at the next visit and on Try again', async () => {
    const { client, reads } = counting([down, down, answer()]);
    const recent = createRecentInvestigations(client);
    recent.ensure();
    await settle();
    expect(recent.getState().list).toEqual({ phase: 'failed', failure: { code: 'NETWORK_UNAVAILABLE' } });
    expect(reads.profiles).toEqual([]);
    recent.ensure();
    await settle();
    expect(reads.lists).toHaveLength(2);
    recent.reload();
    await settle();
    expect(reads.lists).toHaveLength(3);
    expect(recent.getState().list.phase).toBe('ready');
  });
});
