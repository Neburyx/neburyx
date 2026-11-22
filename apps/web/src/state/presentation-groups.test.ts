import { describe, expect, it } from 'vitest';
import { createPresentationStore } from './presentation-state.js';

const KNOWN = new Set(['a', 'b', 'c']);
const store = () => createPresentationStore({ isNode: (key) => KNOWN.has(key), isElement: (key) => KNOWN.has(key) });
const group = (id: string, members: readonly string[], collapsed = true) => ({ id, by: 'entityType', members, collapsed });

describe('the groups of the presentation state', () => {
  it('holds the groups it is given, refuses a member that is not a loaded entity, and writes nothing else', () => {
    const presentation = store();
    const before = presentation.view.getState();
    presentation.setGroups([group('g1', ['a', 'b'])]);
    expect(presentation.view.getState().groups).toEqual([group('g1', ['a', 'b'])]);
    expect([presentation.view.getState().positions, presentation.view.getState().pins, presentation.view.getState().hidden]).toEqual([before.positions, before.pins, before.hidden]);
    expect(() => presentation.setGroups([group('g2', ['nope'])])).toThrow();
    expect(presentation.view.getState().groups).toHaveLength(1);
  });

  it('collapses and expands one group or every group', () => {
    const presentation = store();
    presentation.setGroups([group('g1', ['a']), group('g2', ['b'], false)]);
    presentation.toggleGroup('g1');
    expect(presentation.view.getState().groups.map((entry) => entry.collapsed)).toEqual([false, false]);
    presentation.setGroupsCollapsed(true);
    expect(presentation.view.getState().groups.map((entry) => entry.collapsed)).toEqual([true, true]);
    presentation.toggleGroup('unknown');
    expect(presentation.view.getState().groups).toHaveLength(2);
  });

  it('drops members that are no longer loaded, and a group left empty, when pruned', () => {
    let held = new Set(['a', 'b', 'c']);
    const presentation = createPresentationStore({ isNode: (key) => held.has(key), isElement: (key) => held.has(key) });
    presentation.setGroups([group('g1', ['a', 'b']), group('g2', ['c'])]);
    held = new Set(['a']);
    presentation.prune();
    expect(presentation.view.getState().groups).toEqual([group('g1', ['a'])]);
  });

  it('is part of the snapshot of a set-aside view and is empty after a reset', () => {
    const presentation = store();
    presentation.setGroups([group('g1', ['a'])]);
    const snapshot = presentation.snapshot();
    presentation.reset();
    expect(presentation.view.getState().groups).toEqual([]);
    presentation.restore(snapshot);
    expect(presentation.view.getState().groups).toEqual([group('g1', ['a'])]);
  });

  it('closes the other panels when the Group panel opens, and is closed by them', () => {
    const presentation = store();
    presentation.setFiltersOpen(true);
    presentation.setGroupOpen(true);
    expect([presentation.view.getState().groupOpen, presentation.view.getState().filtersOpen]).toEqual([true, false]);
    presentation.setPathsOpen(true);
    expect(presentation.view.getState().groupOpen).toBe(false);
  });
});
