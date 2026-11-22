import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ProfileProvider } from '../canvas/profile-context.js';
import { entityOf, keyOf, loadedState, profileWith, at } from '../groups/group-kit.js';
import { ClientStateProvider } from '../state/context.js';
import type { ClientState } from '../state/client-state.js';
import { createStore, readable } from '../state/store.js';
import type { ProfileState, ProfileStore } from '../canvas/profile-store.js';
import { setMaskKeepingView } from '../state/test-data.js';
import { staticProfile } from '../test-utils.js';
import { GroupGuard } from './group-guard.js';

afterEach(cleanup);

const profile = profileWith({ 'kind-a': { properties: ['currency', 'holder'], pii: ['holder'] }, 'kind-d': { properties: ['model'] } });
const accounts = [entityOf('kind-a', 'A1', { currency: 'USD', holder: 'Ana' }), entityOf('kind-a', 'A2', { currency: 'USD', holder: 'Ana' })];
const kindD = entityOf('kind-d', 'DV1', { model: 'm' });
const holder = { id: 'property:holder:1', by: 'property:holder', members: accounts.map(keyOf), collapsed: true };
const currency = { id: 'property:currency:1', by: 'property:currency', members: accounts.map(keyOf), collapsed: true };
const byType = { id: 'type:kind-a', by: 'entityType', members: accounts.map(keyOf), collapsed: true };

function mount(state: ClientState, store: ProfileStore = staticProfile('a', profile)) {
  render(
    <ClientStateProvider state={state}>
      <ProfileProvider store={store}>
        <GroupGuard />
      </ProfileProvider>
    </ClientStateProvider>,
  );
}

const groupIds = (state: ClientState) => state.presentation.view.getState().groups.map((group) => group.id);

describe('the guard of the groupings', () => {
  it('leaves every grouping alone when all is well, and draws nothing', () => {
    const state = loadedState([...accounts, kindD]);
    state.presentation.setGroups([holder, currency, byType]);
    mount(state);
    expect(groupIds(state)).toEqual([holder.id, currency.id, byType.id]);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('removes a restored grouping by a property marked pii while masking is on, says so, and keeps the others', () => {
    const state = loadedState([...accounts, kindD]);
    setMaskKeepingView(state, true);
    state.presentation.setGroups([holder, currency, byType]);
    mount(state);
    expect(groupIds(state)).toEqual([currency.id, byType.id]);
    expect(screen.getByRole('status').textContent).toBe('Grouping by a masked property was removed.');
  });

  it('removes the grouping at once when masking is turned on, before the view is read again, and brings nothing back when the read ends', async () => {
    const state = loadedState([...accounts, kindD]);
    state.presentation.setGroups([holder, currency, byType]);
    mount(state);
    expect(groupIds(state)).toHaveLength(3);
    await act(async () => state.setMask(true));
    expect(state.rereading.getState()).toBe(true);
    expect(groupIds(state)).toEqual([currency.id, byType.id]);
    await act(async () => setMaskKeepingView(state, true));
    expect(groupIds(state)).toEqual([currency.id, byType.id]);
  });

  it('removes a grouping by a property when the profile could not be read, and waits while it is read', () => {
    const waiting = createStore<ProfileState>({ sourceId: 'a', request: { phase: 'loading' } });
    const state = loadedState([...accounts, kindD]);
    state.presentation.setGroups([holder, byType]);
    mount(state, { ...readable(waiting), reload: () => undefined });
    expect(groupIds(state)).toEqual([holder.id, byType.id]);
    act(() => waiting.setState({ sourceId: 'a', request: { phase: 'failed', failure: { code: 'SOURCE_UNAVAILABLE', message: 'x', retryable: true, traceId: 't' } } }));
    expect(groupIds(state)).toEqual([byType.id]);
    expect(screen.getByRole('status').textContent).toBe('Grouping by a property was removed: the mapping could not be read.');
  });

  it('adds new entities of a full entity-type group to it', () => {
    const state = loadedState([at(accounts, 0), kindD]);
    state.presentation.setGroups([{ id: 'type:kind-a', by: 'entityType', members: [keyOf(at(accounts, 0))], collapsed: true }]);
    mount(state);
    const key = { sourceId: 'a', principalId: 'principal-1', policyVersion: 'community', filterHash: 'none', params: 'more', mask: false };
    act(() => {
      state.putResult(key, { sourceId: 'a', nodes: [at(accounts, 1)], edges: [] });
      state.setLoaded([...state.investigation.getState().resultKeys, key], [at(accounts, 0), at(accounts, 1), kindD].map((entity) => entity.ref), []);
    });
    expect(state.presentation.view.getState().groups[0]?.members).toEqual([keyOf(at(accounts, 0)), keyOf(at(accounts, 1))]);
  });
});
