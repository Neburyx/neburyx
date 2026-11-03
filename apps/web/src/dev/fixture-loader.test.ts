import { describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { partitionEdges } from '../state/loaded-graph.js';
import { FIXTURE_RECORD, loadFixture } from './fixture-loader.js';
import { testProfile } from './test-profile.js';

describe('loadFixture', () => {
  it('puts records in server state, refs in investigation state and 10 pins in presentation state, and the loaded counts are exact', () => {
    const state = createClientState();
    loadFixture(state, testProfile(), 'principal-1', 1);
    expect(state.server.getState().results.size).toBe(1);
    const investigation = state.investigation.getState();
    expect(investigation.sourceId).toBe('source-a');
    expect(investigation.nodeRefs).toHaveLength(120);
    expect(investigation.edgeRefs.length).toBe(180);
    expect(state.presentation.view.getState().pins.size).toBe(10);
    const graph = state.loadedGraph();
    expect(graph.entities).toMatchObject({ value: 120, quality: 'exact' });
    expect(graph.relationships).toMatchObject({ value: 180, quality: 'exact' });
  });

  it('leaves the asked number of connected entities out of the loaded refs, so their relationships are loaded but not drawable', () => {
    const state = createClientState();
    loadFixture(state, testProfile(), 'principal-1', 1, { withoutEntities: 2 });
    const graph = state.loadedGraph();
    expect(graph.entities).toMatchObject({ value: 118, quality: 'exact' });
    expect(graph.relationships).toMatchObject({ value: 180, quality: 'exact' });
    expect(partitionEdges(graph).notDrawable.length).toBeGreaterThan(0);
    expect(state.presentation.view.getState().pins.size).toBeLessThanOrEqual(10);
  });

  it('loads every entity when none is asked to be left out', () => {
    const state = createClientState();
    loadFixture(state, testProfile(), 'principal-1', 1, { withoutEntities: 0 });
    expect(partitionEdges(state.loadedGraph()).notDrawable).toHaveLength(0);
  });

  it('fills the synthetic investigation record, and another source drops it before the loader fills it again', () => {
    const state = createClientState();
    loadFixture(state, testProfile(), 'principal-1', 1);
    expect(state.investigation.getState().record).toEqual({ ...FIXTURE_RECORD, save: { kind: 'saved', at: '2026-10-28T09:42:00.000Z' } });
    loadFixture(state, testProfile('source-b', ['t1', 't2', 't3']), 'principal-1', 1);
    expect(state.investigation.getState().record).toEqual({ ...FIXTURE_RECORD, save: { kind: 'saved', at: '2026-10-28T09:42:00.000Z' } });
  });

  it('loads the same graph again for the same seed, and another source replaces the first', () => {
    const state = createClientState();
    loadFixture(state, testProfile(), 'principal-1', 1);
    loadFixture(state, testProfile(), 'principal-1', 1);
    expect(state.server.getState().results.size).toBe(1);
    loadFixture(state, testProfile('source-b', ['t1', 't2', 't3']), 'principal-1', 1);
    expect(state.investigation.getState().sourceId).toBe('source-b');
    expect([...state.server.getState().results.values()].every((result) => result.sourceId === 'source-b')).toBe(true);
  });

  it('replaces the pins, not adds to them, when it loads again with another seed, and drops what no longer applies', () => {
    const state = createClientState();
    loadFixture(state, testProfile(), 'principal-1', 1);
    const first = [...state.presentation.view.getState().pins];
    loadFixture(state, testProfile(), 'principal-1', 2);
    const second = [...state.presentation.view.getState().pins];
    expect(second).toHaveLength(10);
    expect(second).not.toEqual(first);
    expect(state.loadedGraph().entities.value).toBe(120);
    expect(state.loadedGraph().relationships.value).toBe(180);
  });

  it('changes no state when the profile is refused', () => {
    const state = createClientState();
    loadFixture(state, testProfile(), 'principal-1', 1);
    const before = { server: state.server.getState(), investigation: state.investigation.getState(), presentation: state.presentation.view.getState() };
    expect(() => loadFixture(state, { ...testProfile('source-b'), entityTypes: [] }, 'principal-1', 1)).toThrowError(expect.objectContaining({ code: 'NO_ENTITY_TYPES' }));
    expect(state.server.getState()).toBe(before.server);
    expect(state.investigation.getState()).toBe(before.investigation);
    expect(state.presentation.view.getState()).toBe(before.presentation);
  });
});
