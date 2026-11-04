import { describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { partitionEdges } from '../state/loaded-graph.js';
import { addFixtureEntities, ADDED_ENTITIES, displaceFixtureEntities, DISPLACED_ENTITIES, FIXTURE_RECORD, loadFixture } from './fixture-loader.js';
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

describe('addFixtureEntities', () => {
  it('loads 25 more entities, each joined to one that is loaded, and reports how many relationships it added; the loaded counts follow and stay exact', () => {
    const state = createClientState();
    loadFixture(state, testProfile(), 'principal-1', 1);
    const added = addFixtureEntities(state, testProfile(), 'principal-1');
    expect(added.entities).toBe(ADDED_ENTITIES);
    expect(added.relationships).toBe(ADDED_ENTITIES);
    const graph = state.loadedGraph();
    expect(graph.entities).toMatchObject({ value: 145, quality: 'exact' });
    expect(graph.relationships).toMatchObject({ value: 180 + added.relationships, quality: 'exact' });
    expect(partitionEdges(graph).notDrawable).toHaveLength(0);
  });

  it('adds different entities and relationships each time, and the same ones for the same graph', () => {
    const first = createClientState();
    const second = createClientState();
    for (const state of [first, second]) loadFixture(state, testProfile(), 'principal-1', 1);
    addFixtureEntities(first, testProfile(), 'principal-1');
    addFixtureEntities(second, testProfile(), 'principal-1');
    expect(first.investigation.getState().nodeRefs).toEqual(second.investigation.getState().nodeRefs);
    expect(first.investigation.getState().edgeRefs).toEqual(second.investigation.getState().edgeRefs);
    addFixtureEntities(first, testProfile(), 'principal-1');
    const refs = first.investigation.getState().nodeRefs.map((ref) => ref.stableId);
    expect(new Set(refs).size).toBe(170);
    const edges = first.investigation.getState().edgeRefs.map((ref) => JSON.stringify(ref));
    expect(new Set(edges).size).toBe(edges.length);
  });

  it('keeps the pins, the positions and the entities that were loaded', () => {
    const state = createClientState();
    loadFixture(state, testProfile(), 'principal-1', 1);
    const pins = [...state.presentation.view.getState().pins];
    const first = state.investigation.getState().nodeRefs.slice(0, 120);
    addFixtureEntities(state, testProfile(), 'principal-1');
    expect([...state.presentation.view.getState().pins]).toEqual(pins);
    expect(state.investigation.getState().nodeRefs.slice(0, 120)).toEqual(first);
  });

  it('refuses a profile without a stored relationship type and changes nothing', () => {
    const state = createClientState();
    loadFixture(state, testProfile(), 'principal-1', 1);
    const aggregateOnly = { ...testProfile(), relationshipTypes: testProfile().relationshipTypes.map((relationship) => ({ ...relationship, aggregate: true })) };
    const before = state.investigation.getState();
    expect(() => addFixtureEntities(state, aggregateOnly, 'principal-1')).toThrowError(expect.objectContaining({ code: 'NO_RELATIONSHIP_TYPES' }));
    expect(state.investigation.getState()).toBe(before);
  });
});

describe('displaceFixtureEntities', () => {
  it('puts the first ten unpinned entities, in the loaded order, far from where they were, through the store function a drag uses, and leaves the pinned and the others alone', () => {
    const state = createClientState();
    loadFixture(state, testProfile(), 'principal-1', 1);
    const nodes = state.investigation.getState().nodeRefs.map((ref) => elementKey(ref));
    const pins = state.presentation.view.getState().pins;
    const before = new Map(nodes.map((key, index) => [key, { x: index, y: -index }] as const));
    state.presentation.setPositions(before);
    const displaced = displaceFixtureEntities(state);
    expect(displaced).toBe(DISPLACED_ENTITIES);
    const after = state.presentation.view.getState().positions;
    const first = nodes.filter((key) => !pins.has(key)).slice(0, DISPLACED_ENTITIES);
    for (const key of first) expect(Math.abs(after.get(key)?.x ?? 0), key).toBeGreaterThan(5000);
    for (const key of nodes.filter((candidate) => !first.includes(candidate))) expect(after.get(key), key).toEqual(before.get(key));
  });

  it('displaces fewer when fewer are loaded, and none when nothing is', () => {
    const state = createClientState();
    loadFixture(state, testProfile(), 'principal-1', 1);
    expect(displaceFixtureEntities(state, 3)).toBe(3);
    const empty = createClientState();
    empty.bindSource('source-a');
    expect(displaceFixtureEntities(empty)).toBe(0);
  });
});
