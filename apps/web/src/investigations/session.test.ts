import { describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { StateError } from '../state/errors.js';
import { elementKey } from '../state/keys.js';
import { openedKey } from './open-flow.js';
import { INVESTIGATION_A, INVESTIGATION_B, nodeOf } from './test-data.js';

const PRINCIPAL = 'principal-1';

function showing(state: ReturnType<typeof createClientState>, id: string, sourceId: string, stableId: string, mask = false) {
  const node = nodeOf(sourceId, 'kind-a', stableId);
  const key = openedKey(sourceId, PRINCIPAL, id, mask);
  return state.show({ id, sourceId, record: { title: stableId, caseRef: null, status: 'open' as const, readOnly: false, version: 1, save: { kind: 'unsaved' } }, resultKeys: [key], nodeRefs: [node.ref], edgeRefs: [] }, [{ key, result: { sourceId, nodes: [node], edges: [] } }]);
}

describe('showing an investigation', () => {
  it('binds the source, the record and one entity together and reports it as fresh', () => {
    const state = createClientState();
    expect(showing(state, INVESTIGATION_A, 'source-a', 'A-1')).toBe('fresh');
    const held = state.investigation.getState();
    expect(held).toMatchObject({ id: INVESTIGATION_A, sourceId: 'source-a', record: { title: 'A-1', save: { kind: 'unsaved' } } });
    expect(state.loadedGraph().entities).toEqual({ value: 1, quality: 'exact', scope: 'loaded in this view' });
  });

  it('does nothing when the investigation is the one shown', () => {
    const state = createClientState();
    showing(state, INVESTIGATION_A, 'source-a', 'A-1');
    state.presentation.setPosition(elementKey(nodeOf('source-a', 'kind-a', 'A-1').ref), { x: 5, y: 6 });
    expect(showing(state, INVESTIGATION_A, 'source-a', 'A-1')).toBe('current');
    expect(state.presentation.view.getState().positions.size).toBe(1);
  });

  it.each([
    ['of the same source', 'source-a'],
    ['of another source', 'source-b'],
  ])('brings an investigation %s back as it was left: its entities, positions, pins, selection and viewport, with no read', (_name, otherSource) => {
    const state = createClientState();
    showing(state, INVESTIGATION_A, 'source-a', 'A-1');
    const added = nodeOf('source-a', 'kind-a', 'A-2');
    const addedKey = openedKey('source-a', PRINCIPAL, INVESTIGATION_A, false);
    const first = state.investigation.getState();
    state.putResult({ ...addedKey, params: 'added' }, { sourceId: 'source-a', nodes: [added], edges: [] });
    state.setLoaded([...first.resultKeys, { ...addedKey, params: 'added' }], [...first.nodeRefs, added.ref], []);
    const one = elementKey(first.nodeRefs[0] ?? added.ref);
    const two = elementKey(added.ref);
    state.presentation.setPosition(one, { x: 10, y: 20 });
    state.presentation.pin([two]);
    state.presentation.select([one]);
    state.presentation.setViewport({ zoom: 2, x: 3, y: 4 });

    expect(showing(state, INVESTIGATION_B, otherSource, 'C-1')).toBe('fresh');
    expect(state.investigation.getState()).toMatchObject({ id: INVESTIGATION_B, sourceId: otherSource });
    expect(state.presentation.view.getState().positions.size).toBe(0);
    expect(state.presentation.view.getState().viewport).toBeUndefined();
    expect(state.loadedGraph().nodes.map((node) => node.ref.stableId)).toEqual(['C-1']);

    expect(state.resume(INVESTIGATION_A, false)).toBe('resumed');
    expect(state.investigation.getState()).toMatchObject({ id: INVESTIGATION_A, sourceId: 'source-a' });
    expect(state.loadedGraph().nodes.map((node) => node.ref.stableId)).toEqual(['A-1', 'A-2']);
    const presentation = state.presentation.view.getState();
    expect(presentation.positions.get(one)).toEqual({ x: 10, y: 20 });
    expect([...presentation.pins]).toEqual([two]);
    expect([...presentation.selection]).toEqual([one]);
    expect(presentation.viewport).toEqual({ zoom: 2, x: 3, y: 4 });
    expect(state.holds(INVESTIGATION_B, false)).toBe(true);
    expect(state.resume(INVESTIGATION_A, false)).toBe('current');
  });

  it('never shows an empty graph between two investigations', () => {
    const state = createClientState();
    showing(state, INVESTIGATION_A, 'source-a', 'A-1');
    const seen: number[] = [];
    state.investigation.subscribe(() => seen.push(state.loadedGraph().nodes.length));
    state.server.subscribe(() => seen.push(state.loadedGraph().nodes.length));
    showing(state, INVESTIGATION_B, 'source-b', 'C-1');
    state.resume(INVESTIGATION_A, false);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((count) => count > 0)).toBe(true);
  });

  it('holds nothing of an investigation it was not given, and says so', () => {
    const state = createClientState();
    expect(state.holds(INVESTIGATION_A, false)).toBe(false);
    expect(state.resume(INVESTIGATION_A, false)).toBeUndefined();
  });

  it('refuses a result, a key or a reference that belongs to another source, and changes nothing', () => {
    const state = createClientState();
    showing(state, INVESTIGATION_A, 'source-a', 'A-1');
    const before = state.investigation.getState();
    const foreign = nodeOf('source-b', 'kind-a', 'X-1');
    const key = openedKey('source-a', PRINCIPAL, INVESTIGATION_B, false);
    const attempt = (nodeRefs: readonly (typeof foreign.ref)[], result: { sourceId: string }) =>
      state.show({ id: INVESTIGATION_B, sourceId: 'source-a', record: { title: 'x', caseRef: null, status: 'open' as const, readOnly: false, version: 1, save: { kind: 'unsaved' } }, resultKeys: [key], nodeRefs, edgeRefs: [] }, [{ key, result: { sourceId: result.sourceId, nodes: [], edges: [] } }]);
    expect(() => attempt([foreign.ref], { sourceId: 'source-a' })).toThrow(StateError);
    expect(() => attempt([], { sourceId: 'source-b' })).toThrow(StateError);
    expect(state.investigation.getState()).toBe(before);
    expect(state.holds(INVESTIGATION_B, false)).toBe(false);
  });
});

describe('the cache key', () => {
  it('keeps a masked and an unmasked result of the same entity apart, in both directions', () => {
    const state = createClientState();
    showing(state, INVESTIGATION_A, 'source-a', 'A-1', false);
    const plain = openedKey('source-a', PRINCIPAL, INVESTIGATION_A, false);
    const masked = openedKey('source-a', PRINCIPAL, INVESTIGATION_A, true);
    expect(state.server.get(masked)).toBeUndefined();
    const hidden = { ...nodeOf('source-a', 'kind-a', 'A-1'), display: { title: 'A•••', type: 'kind-a' } };
    state.putResult(masked, { sourceId: 'source-a', nodes: [hidden], edges: [] });
    expect(state.server.get(plain)?.nodes[0]?.display.title).toBe('kind-a A-1');
    expect(state.server.get(masked)?.nodes[0]?.display.title).toBe('A•••');
    const node = nodeOf('source-a', 'kind-a', 'A-1');
    state.setLoaded([masked], [node.ref], []);
    expect(state.loadedGraph().nodes.map((shown) => shown.display.title)).toEqual(['A•••']);
    state.setLoaded([plain], [node.ref], []);
    expect(state.loadedGraph().nodes.map((shown) => shown.display.title)).toEqual(['kind-a A-1']);
    const unmaskedOnly = createClientState();
    const only = openedKey('source-a', PRINCIPAL, INVESTIGATION_A, true);
    showing(unmaskedOnly, INVESTIGATION_A, 'source-a', 'A-1', true);
    expect(unmaskedOnly.server.get({ ...only, mask: false })).toBeUndefined();
    expect(unmaskedOnly.server.get(only)).toBeDefined();
  });
});

describe('a graph that names a key whose result was stored for the other mask', () => {
  it('shows nothing from it, so a masked ask is never answered with plain values and the other way round', () => {
    const state = createClientState();
    showing(state, INVESTIGATION_A, 'source-a', 'A-1', false);
    const node = nodeOf('source-a', 'kind-a', 'A-1');
    state.setLoaded([openedKey('source-a', PRINCIPAL, INVESTIGATION_A, true)], [node.ref], []);
    expect(state.loadedGraph().nodes).toEqual([]);
  });
});

describe('binding a source by hand, as the development fixture does', () => {
  it('lets go of the investigations set aside whose results went with the source, so they are read again and never shown empty', () => {
    const state = createClientState();
    showing(state, INVESTIGATION_A, 'source-a', 'A-1');
    showing(state, INVESTIGATION_B, 'source-b', 'C-1');
    expect(state.holds(INVESTIGATION_A, false)).toBe(true);
    state.bindSource('source-c');
    expect(state.holds(INVESTIGATION_A, false)).toBe(true);
    state.bindSource('source-a');
    state.bindSource('source-d');
    expect(state.resume(INVESTIGATION_A, false)).toBeUndefined();
  });
});
