import { describe, expect, it, vi } from 'vitest';
import { elementKey } from '../state/keys.js';
import { groupAllByType, groupByComponent, groupByProperty, groupSelection, groupTypeOnly, ungroupAll } from './group-actions.js';
import { entityOf, keyOf, linkOf, loadedState, profileWith } from './group-kit.js';

const d1 = entityOf('kind-d', 'DV1', { currency: 'USD' });
const d2 = entityOf('kind-d', 'DV2', { currency: 'USD' });
const a1 = entityOf('kind-a', 'A1', { currency: 'EUR' });
const c1 = entityOf('kind-c', 'C1');
const all = [d1, d2, a1, c1];
const profile = profileWith({ 'kind-d': { properties: ['currency'] }, 'kind-a': { properties: ['currency'] }, 'kind-c': {} });
const groupsOf = (state: ReturnType<typeof loadedState>) => state.presentation.view.getState().groups;

describe('grouping by entity type from the menus', () => {
  it('groups every loaded entity by type, each group collapsed, and writes no position, pin or hidden state', () => {
    const state = loadedState(all);
    state.presentation.pin([keyOf(d1)]);
    state.presentation.setPosition(keyOf(a1), { x: 3, y: 4 });
    const before = state.presentation.view.getState();
    expect(groupAllByType(state)).toEqual({ applied: true, left: 0 });
    const after = state.presentation.view.getState();
    expect(groupsOf(state).map((group) => [group.id, group.members.length, group.collapsed])).toEqual([['type:kind-d', 2, true], ['type:kind-a', 1, true], ['type:kind-c', 1, true]]);
    expect([after.positions, after.pins, after.hidden]).toEqual([before.positions, before.pins, before.hidden]);
  });

  it('says nothing is loaded and makes no group when nothing is loaded', () => {
    const state = loadedState([]);
    expect(groupAllByType(state)).toEqual({ applied: false, reason: 'nothing-loaded' });
    expect(groupsOf(state)).toEqual([]);
  });

  it('groups one type only, taking its entities out of another group and leaving the other groups as they are', () => {
    const state = loadedState(all);
    state.presentation.setGroups([{ id: 'component:1', by: 'component', members: [keyOf(d1), keyOf(a1)], collapsed: true }]);
    groupTypeOnly(state, 'kind-d');
    expect(groupsOf(state).map((group) => [group.id, group.members])).toEqual([['component:1', [keyOf(a1)]], ['type:kind-d', [keyOf(d1), keyOf(d2)]]]);
  });

  it('groups the selected entities by type and ignores relationships, moving them from other groups', () => {
    const link = linkOf('L1', d1, a1);
    const state = loadedState(all, [link]);
    state.presentation.setGroups([{ id: 'component:1', by: 'component', members: [keyOf(d1), keyOf(a1)], collapsed: true }]);
    groupSelection(state, [keyOf(d1), keyOf(d2), keyOf(a1), 'edge-key']);
    expect(groupsOf(state).map((group) => [group.id, group.members.length])).toEqual([['selection:kind-d:1', 2], ['selection:kind-a:1', 1]]);
  });

  it('groups part of a complete type group from the selection and leaves the unselected members where they were', () => {
    const state = loadedState(all);
    groupAllByType(state);
    groupSelection(state, [keyOf(d1)]);
    expect(groupsOf(state).map((group) => [group.id, group.members.length])).toEqual([['type:kind-d', 1], ['type:kind-a', 1], ['type:kind-c', 1], ['selection:kind-d:1', 1]]);
  });

  it('does nothing when the type item is chosen on a group that already holds every entity of the type', () => {
    const state = loadedState(all);
    groupAllByType(state);
    state.presentation.setGroupsCollapsed(false);
    const before = groupsOf(state);
    groupTypeOnly(state, 'kind-d');
    expect(groupsOf(state)).toBe(before);
  });

  it('gives a new selection group an id no live group holds, even after a group was emptied', () => {
    const state = loadedState([d1, d2, a1]);
    state.presentation.setGroups([
      { id: 'selection:kind-d:1', by: 'entityType', members: [keyOf(d1)], collapsed: true },
      { id: 'selection:kind-d:2', by: 'entityType', members: [keyOf(d2)], collapsed: true },
    ]);
    groupSelection(state, [keyOf(d1), keyOf(d2)]);
    groupSelection(state, [keyOf(d1)]);
    groupSelection(state, [keyOf(d2)]);
    const ids = groupsOf(state).map((group) => group.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(groupsOf(state).flatMap((group) => group.members).sort()).toEqual([keyOf(d1), keyOf(d2)].sort());
  });

  it('does not replace a live selection group that holds other members when the count of selection groups is one below its index', () => {
    const d3 = entityOf('kind-d', 'DV3', { currency: 'USD' });
    const state = loadedState([d1, d2, d3]);
    state.presentation.setGroups([
      { id: 'selection:kind-d:2', by: 'entityType', members: [keyOf(d1)], collapsed: true },
      { id: 'selection:kind-d:3', by: 'entityType', members: [keyOf(d2)], collapsed: true },
    ]);
    groupSelection(state, [keyOf(d3)]);
    const ids = groupsOf(state).map((group) => group.id);
    expect(new Set(ids).size).toBe(3);
    expect(groupsOf(state).flatMap((group) => group.members).sort()).toEqual([keyOf(d1), keyOf(d2), keyOf(d3)].sort());
  });

  it('ungroups all and leaves the arrangement as it is', () => {
    const state = loadedState(all);
    state.presentation.setPosition(keyOf(a1), { x: 3, y: 4 });
    groupAllByType(state);
    ungroupAll(state);
    expect(groupsOf(state)).toEqual([]);
    expect(state.presentation.view.getState().positions.get(keyOf(a1))).toEqual({ x: 3, y: 4 });
  });
});

describe('grouping by property and by component', () => {
  it('groups by an eligible property and says how many entities have no value', () => {
    const state = loadedState(all);
    expect(groupByProperty(state, 'currency', profile)).toEqual({ applied: true, left: 1 });
    expect(groupsOf(state).map((group) => group.members.length)).toEqual([2, 1]);
  });

  it('refuses a property that is not eligible, and one that no entity carries', () => {
    const state = loadedState(all);
    expect(groupByProperty(state, 'unmapped', profile)).toEqual({ applied: false, reason: 'ineligible' });
    expect(groupByProperty(loadedState([c1]), 'currency', profile)).toEqual({ applied: false, reason: 'ineligible' });
    expect(groupByProperty(loadedState([entityOf('kind-d', 'D9')]), 'currency', profile)).toEqual({ applied: false, reason: 'no-group' });
    expect(groupsOf(state)).toEqual([]);
  });

  it('groups by component and makes none when no relationship is loaded', () => {
    const state = loadedState(all, [linkOf('L1', d1, a1)]);
    expect(groupByComponent(state)).toEqual({ applied: true, left: 2 });
    expect(groupsOf(state)[0]?.members.map((member) => JSON.parse(member)[3]).sort()).toEqual(['A1', 'DV1']);
    expect(groupByComponent(loadedState(all))).toEqual({ applied: false, reason: 'no-group' });
  });

  it('writes no member key that is not a loaded entity', () => {
    const state = loadedState(all);
    expect(() => state.presentation.setGroups([{ id: 'g', by: 'component', members: [elementKey({ sourceId: 'a', entityType: 'kind-d', stableId: 'NOPE' })], collapsed: true }])).toThrow();
  });
});

describe('no way of grouping asks the source', () => {
  it('sends nothing for type, one type, the selection, a property or a component', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const state = loadedState(all, [linkOf('L1', d1, a1)]);
    groupAllByType(state);
    groupTypeOnly(state, 'kind-d');
    groupSelection(state, [keyOf(d1), keyOf(a1)]);
    groupByProperty(state, 'currency', profile);
    groupByComponent(state);
    ungroupAll(state);
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRestore();
  });
});
