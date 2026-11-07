import { act, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ApiClient, ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { testProfile } from '../dev/test-profile.js';
import { createClientState } from '../state/client-state.js';
import { key, ref, result } from '../state/test-data.js';
import { me, renderApp, source, stubFactory, WorkspaceHarness } from '../test-utils.js';
import { createProfileStore } from './profile-store.js';
import type { SourceProfile } from '@neburyx/contracts';

function clientWith(replies: Array<(result: ApiResult<SourceProfile>) => void>): { readonly client: ApiClient; readonly asked: string[] } {
  const asked: string[] = [];
  const client = fakeClient({
    getMe: async () => ({ ok: true, value: me() }),
    getSources: async () => ({ ok: true, value: { items: [source('a')], nextCursor: null } }),
    getProfile: (sourceId) => {
      asked.push(sourceId);
      return new Promise((resolve) => replies.push(resolve));
    },
  });
  return { client, asked };
}

describe('the profile on Explore', () => {
  it('reaches the canvas for the bound source, and is asked for once', async () => {
    const replies: Array<(result: ApiResult<SourceProfile>) => void> = [];
    const { client, asked } = clientWith(replies);
    const state = createClientState();
    state.bindSource('a');
    const factory = stubFactory();
    renderApp('/explore', client, state, undefined, factory.create);
    expect(factory.made[0]?.scenes.at(-1)?.profile).toBeUndefined();
    await act(async () => replies[0]?.({ ok: true, value: testProfile('a') }));
    expect(factory.made[0]?.scenes.at(-1)?.profile?.sourceId).toBe('a');
    expect(asked).toEqual(['a']);
  });

  it('is not asked for while no source is bound', () => {
    const { client, asked } = clientWith([]);
    renderApp('/explore', client, createClientState(), undefined, stubFactory().create);
    expect(asked).toEqual([]);
  });

  it('shows the failure of the first read in the notice strip, with the trace ID, and the canvas has no profile', async () => {
    const replies: Array<(result: ApiResult<SourceProfile>) => void> = [];
    const { client } = clientWith(replies);
    const state = createClientState();
    state.bindSource('a');
    const factory = stubFactory();
    renderApp('/explore', client, state, undefined, factory.create);
    await act(async () => replies[0]?.({ ok: false, failure: { code: 'SOURCE_UNAVAILABLE', message: 'unavailable', retryable: true, traceId: 'trace-5' } }));
    expect(within(screen.getByRole('group', { name: 'Notices' })).getByRole('alert').textContent).toBe('The source did not answer. Try again shortly. · trace trace-5');
    expect(factory.made[0]?.scenes.at(-1)?.profile).toBeUndefined();
  });

  it('changes what the canvas draws from the generic look to the profile\'s, without moving any entity', async () => {
    const replies: Array<(result: ApiResult<SourceProfile>) => void> = [];
    const { client } = clientWith(replies);
    const state = createClientState();
    state.bindSource('a');
    state.putResult(key('a'), result('a', ['n1'], []));
    state.setLoaded([key('a')], [ref('a', 'type-a', 'n1')], []);
    const factory = stubFactory();
    renderApp('/explore', client, state, undefined, factory.create);
    const before = factory.made[0]?.scenes.at(-1)?.entities[0];
    expect(before?.look).toEqual({ iconKey: 'generic', line1: 'n1', line2: 'type-a' });
    const profile = testProfile('a', ['type-a', 'type-b', 'type-c']);
    await act(async () => replies[0]?.({ ok: true, value: { ...profile, entityTypes: profile.entityTypes.map((entry) => ({ ...entry, icon: 'person' as const, label: `Label ${entry.type}`, displayName: `Label ${entry.type}` })) } }));
    const after = factory.made[0]?.scenes.at(-1)?.entities[0];
    expect(after?.look).toEqual({ iconKey: 'person', line1: 'n1', line2: 'Label type-a' });
    expect(after?.position).toEqual(before?.position ?? after?.position);
  });

  it.each([
    ['with a trace ID', { code: 'SOURCE_UNAVAILABLE', message: 'unavailable', retryable: true, traceId: 'trace-7' } as const, 'The source did not answer. Try again shortly. · trace trace-7'],
    ['without one', { code: 'NETWORK_UNAVAILABLE' } as const, 'NETWORK_UNAVAILABLE'],
  ])('keeps the profile\'s look and every position when a later read of it fails %s, and names the failure in the strip', async (_name, failure, text) => {
    const replies: Array<(result: ApiResult<SourceProfile>) => void> = [];
    const { client } = clientWith(replies);
    const state = createClientState();
    state.bindSource('a');
    state.putResult(key('a'), result('a', ['n1', 'n2'], []));
    state.setLoaded([key('a')], [ref('a', 'type-a', 'n1'), ref('a', 'type-a', 'n2')], []);
    const store = createProfileStore(client, state.investigation);
    const factory = stubFactory();
    render(<WorkspaceHarness client={client} state={state} profile={store} createRenderer={factory.create} />);
    const profile = testProfile('a', ['type-a', 'type-b', 'type-c']);
    await act(async () => replies[0]?.({ ok: true, value: { ...profile, entityTypes: profile.entityTypes.map((entry) => ({ ...entry, icon: 'person' as const, label: `Label ${entry.type}`, displayName: `Label ${entry.type}` })) } }));
    const before = factory.made[0]?.scenes.at(-1);
    await act(async () => store.reload());
    await act(async () => replies[1]?.({ ok: false, failure }));
    const after = factory.made[0]?.scenes.at(-1);
    expect(within(screen.getByRole('group', { name: 'Notices' })).getAllByRole('alert').map((alert) => alert.textContent)).toContain(text);
    expect(after?.entities.map((entity) => entity.look)).toEqual(before?.entities.map((entity) => entity.look));
    expect(after?.entities.every((entity) => entity.look.iconKey === 'person' && entity.look.line2.startsWith('Label '))).toBe(true);
    expect(after?.entities.map((entity) => entity.position)).toEqual(before?.entities.map((entity) => entity.position));
  });
});
