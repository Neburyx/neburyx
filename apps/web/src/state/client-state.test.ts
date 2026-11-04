import { describe, expect, it, vi } from 'vitest';
import { partitionEdges } from './loaded-graph.js';
import { createClientState } from './client-state.js';
import { elementKey } from './keys.js';
import { edge, edgeRef, key, node, ref, result } from './test-data.js';
import { edgeKey } from './keys.js';

function loaded() {
  const state = createClientState();
  state.bindSource('source-a');
  state.putResult(key('source-a'), result('source-a', ['n1', 'n2', 'n3'], [['e1', 'n1', 'n2'], ['e2', 'n2', 'n3']]));
  state.setLoaded([key('source-a')], [ref('source-a', 'type-a', 'n1'), ref('source-a', 'type-a', 'n2')], [edgeRef('source-a', 'e1')]);
  return state;
}

describe('presentation changes', () => {
  it('leave server, investigation and job state with the same objects, and notify nobody there', () => {
    const state = loaded();
    const before = { server: state.server.getState(), investigation: state.investigation.getState(), jobs: state.jobs.getState() };
    const listener = vi.fn();
    for (const store of [state.server, state.investigation, state.jobs]) store.subscribe(listener);
    const first = elementKey(ref('source-a', 'type-a', 'n1'));
    state.presentation.select([first]);
    state.presentation.setPosition(first, { x: 4, y: 5 });
    state.presentation.pin([first]);
    state.presentation.setPanelSize('legend', 320);
    state.presentation.setViewport({ zoom: 2, x: 1, y: 1 });
    expect(state.server.getState()).toBe(before.server);
    expect(state.investigation.getState()).toBe(before.investigation);
    expect(state.jobs.getState()).toBe(before.jobs);
    expect(listener).not.toHaveBeenCalled();
  });

  it('are refused for an element the investigation does not hold, and leave the state as it was', () => {
    const state = loaded();
    const before = state.presentation.view.getState();
    const stranger = elementKey(ref('source-a', 'type-a', 'n3'));
    expect(() => state.presentation.select([stranger])).toThrowError(expect.objectContaining({ code: 'UNKNOWN_ELEMENT' }));
    expect(() => state.presentation.setPosition(stranger, { x: 1, y: 1 })).toThrowError(expect.objectContaining({ code: 'UNKNOWN_ELEMENT' }));
    expect(() => state.presentation.pin([elementKey(ref('source-a', 'type-a', 'n1')), stranger])).toThrowError(expect.objectContaining({ code: 'UNKNOWN_ELEMENT' }));
    expect(state.presentation.view.getState()).toBe(before);
  });
});

describe('several positions at once', () => {
  it('are stored in one update and keep the positions of the others', () => {
    const state = loaded();
    const first = elementKey(ref('source-a', 'type-a', 'n1'));
    const second = elementKey(ref('source-a', 'type-a', 'n2'));
    state.presentation.setPosition(first, { x: 1, y: 1 });
    const listener = vi.fn();
    state.presentation.view.subscribe(listener);
    state.presentation.setPositions(new Map([[second, { x: 2, y: 3 }]]));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(state.presentation.view.getState().positions).toEqual(new Map([[first, { x: 1, y: 1 }], [second, { x: 2, y: 3 }]]));
  });

  it('are refused as a whole when one names an element the investigation does not hold', () => {
    const state = loaded();
    const first = elementKey(ref('source-a', 'type-a', 'n1'));
    const stranger = elementKey(ref('source-a', 'type-a', 'n3'));
    const before = state.presentation.view.getState();
    expect(() => state.presentation.setPositions(new Map([[first, { x: 1, y: 1 }], [stranger, { x: 2, y: 2 }]]))).toThrowError(expect.objectContaining({ code: 'UNKNOWN_ELEMENT' }));
    expect(state.presentation.view.getState()).toBe(before);
  });
});

describe('the cached results', () => {
  it('are returned for the same key and for none that differs in any one of its five parts', () => {
    const state = createClientState();
    state.bindSource('source-a');
    const stored = result('source-a', ['n1']);
    state.putResult(key('source-a'), stored);
    expect(state.server.get(key('source-a'))).toBe(stored);
    const base = key('source-a');
    for (const changed of [{ ...base, sourceId: 'source-b' }, { ...base, principalId: 'principal-2' }, { ...base, policyVersion: 'v2' }, { ...base, filterHash: 'abc' }, { ...base, params: 'seed-2' }]) {
      expect(state.server.get(changed)).toBeUndefined();
    }
  });

  it('are not stored when the result, its key or the investigation name another source, and nothing else changes', () => {
    const state = createClientState();
    expect(() => state.putResult(key('source-a'), result('source-a', ['n1']))).toThrowError(expect.objectContaining({ code: 'NO_SOURCE_BOUND' }));
    state.bindSource('source-a');
    const before = state.server.getState();
    expect(() => state.putResult(key('source-b'), result('source-b', ['n1']))).toThrowError(expect.objectContaining({ code: 'SOURCE_MISMATCH' }));
    expect(() => state.putResult(key('source-a'), result('source-b', ['n1']))).toThrowError(expect.objectContaining({ code: 'SOURCE_MISMATCH' }));
    const mixed = { sourceId: 'source-a', nodes: [node('source-a', 'n1'), node('source-b', 'n2')], edges: [] };
    expect(() => state.putResult(key('source-a'), mixed)).toThrowError(expect.objectContaining({ code: 'SOURCE_MISMATCH' }));
    const mixedEdges = { sourceId: 'source-a', nodes: [node('source-a', 'n1')], edges: [edge('source-b', 'e1', 'n1', 'n1')] };
    expect(() => state.putResult(key('source-a', 'edges'), mixedEdges)).toThrowError(expect.objectContaining({ code: 'SOURCE_MISMATCH' }));
    expect(state.server.getState()).toBe(before);
  });
});

describe('the loaded graph', () => {
  it('is derived from the records and the refs: only what a ref names, counted exact, once each', () => {
    const graph = loaded().loadedGraph();
    expect(graph.nodes.map((item) => item.ref.stableId)).toEqual(['n1', 'n2']);
    expect(graph.edges.map((item) => 'stableId' in item.ref && item.ref.stableId)).toEqual(['e1']);
    expect(graph.entities).toMatchObject({ value: 2, quality: 'exact' });
    expect(graph.relationships).toMatchObject({ value: 1, quality: 'exact' });
  });

  it('does not count a record that no ref names, and does not copy records into the other partitions', () => {
    const state = loaded();
    const refs = state.investigation.getState();
    expect(refs.nodeRefs).toHaveLength(2);
    expect(JSON.stringify(state.investigation.getState())).not.toContain('display');
    expect(JSON.stringify(state.presentation.view.getState().selection)).not.toContain('display');
    expect(state.loadedGraph().entities.value).toBe(2);
  });

  it('is the same object while the records and the refs are the same, so everything that asks shares one derivation, and a new one when either changes', () => {
    const state = loaded();
    const first = state.loadedGraph();
    expect(state.loadedGraph()).toBe(first);
    state.presentation.setTool('pan');
    expect(state.loadedGraph()).toBe(first);
    state.putResult(key('source-a', 'second'), result('source-a', ['n1']));
    const afterRecords = state.loadedGraph();
    expect(afterRecords).not.toBe(first);
    state.setLoaded([key('source-a'), key('source-a', 'second')], [ref('source-a', 'type-a', 'n1')], []);
    const afterRefs = state.loadedGraph();
    expect(afterRefs).not.toBe(afterRecords);
    expect(afterRefs.entities.value).toBe(1);
  });

  it('keeps refusing an element that is no longer held after the refs change, though the sets of held keys are kept between calls', () => {
    const state = loaded();
    const second = elementKey(ref('source-a', 'type-a', 'n2'));
    state.presentation.setPosition(second, { x: 1, y: 1 });
    state.setLoaded([key('source-a')], [ref('source-a', 'type-a', 'n1')], []);
    expect(() => state.presentation.setPosition(second, { x: 2, y: 2 })).toThrowError(expect.objectContaining({ code: 'UNKNOWN_ELEMENT' }));
    expect(state.presentation.view.getState().positions.has(second)).toBe(false);
  });

  it('counts a record once when two cached results hold it', () => {
    const state = loaded();
    state.putResult(key('source-a', 'second'), result('source-a', ['n1', 'n2']));
    state.setLoaded([key('source-a'), key('source-a', 'second')], [ref('source-a', 'type-a', 'n1'), ref('source-a', 'type-a', 'n2')], [edgeRef('source-a', 'e1')]);
    expect(state.loadedGraph().entities.value).toBe(2);
  });
});

describe('the pointer tool and the viewport', () => {
  it('has the select tool at first, changes it by one command, and keeps it when another source is bound', () => {
    const state = createClientState();
    expect(state.presentation.view.getState().tool).toBe('select');
    state.bindSource('source-a');
    state.presentation.setTool('pan');
    expect(state.presentation.view.getState().tool).toBe('pan');
    state.bindSource('source-b');
    expect(state.presentation.view.getState().tool).toBe('pan');
  });

  it('has no open tool flyout at first, opens and closes one by id, and closes it when another source is bound', () => {
    const state = createClientState();
    expect(state.presentation.view.getState().openTool).toBeUndefined();
    state.bindSource('source-a');
    state.presentation.setOpenTool({ id: 'explore', registration: 1 });
    expect(state.presentation.view.getState().openTool).toEqual({ id: 'explore', registration: 1 });
    state.presentation.setOpenTool(undefined);
    expect(state.presentation.view.getState().openTool).toBeUndefined();
    state.presentation.setOpenTool({ id: 'explore', registration: 1 });
    state.bindSource('source-b');
    expect(state.presentation.view.getState().openTool).toBeUndefined();
  });

  it('has no open context menu at first, opens and closes one, replaces an open one, and closes it when another source is bound', () => {
    const state = createClientState();
    expect(state.presentation.view.getState().openMenu).toBeUndefined();
    state.bindSource('source-a');
    state.presentation.setOpenMenu({ kind: 'canvas', key: undefined, x: 1, y: 2 });
    expect(state.presentation.view.getState().openMenu).toEqual({ kind: 'canvas', key: undefined, x: 1, y: 2 });
    state.presentation.setOpenMenu({ kind: 'node', key: 'k', x: 3, y: 4 });
    expect(state.presentation.view.getState().openMenu).toEqual({ kind: 'node', key: 'k', x: 3, y: 4 });
    state.presentation.setOpenMenu(undefined);
    expect(state.presentation.view.getState().openMenu).toBeUndefined();
    state.presentation.setOpenMenu({ kind: 'canvas', key: undefined, x: 1, y: 2 });
    state.bindSource('source-b');
    expect(state.presentation.view.getState().openMenu).toBeUndefined();
  });

  it('has no viewport until one is set, keeps one that equals the identity view, and loses it when another source is bound', () => {
    const state = createClientState();
    state.bindSource('source-a');
    expect(state.presentation.view.getState().viewport).toBeUndefined();
    state.presentation.setViewport({ zoom: 1, x: 0, y: 0 });
    expect(state.presentation.view.getState().viewport).toEqual({ zoom: 1, x: 0, y: 0 });
    state.bindSource('source-b');
    expect(state.presentation.view.getState().viewport).toBeUndefined();
  });

  it('refuses a viewport with a number that is not finite, with INVALID_VIEWPORT, and changes nothing', () => {
    const state = createClientState();
    state.presentation.setViewport({ zoom: 2, x: 3, y: 4 });
    const before = state.presentation.view.getState();
    for (const viewport of [{ zoom: Number.NaN, x: 0, y: 0 }, { zoom: 1, x: Number.POSITIVE_INFINITY, y: 0 }, { zoom: 1, x: 0, y: Number.NEGATIVE_INFINITY }]) {
      expect(() => state.presentation.setViewport(viewport)).toThrow(expect.objectContaining({ code: 'INVALID_VIEWPORT' }));
    }
    expect(state.presentation.view.getState()).toBe(before);
  });
});

describe('the relationships a loaded graph can draw', () => {
  it('splits relationships into those between two loaded entities and those with an entity that is not loaded, from either end', () => {
    const state = createClientState();
    state.bindSource('source-a');
    state.putResult(key('source-a'), result('source-a', ['n1', 'n2'], [['e1', 'n1', 'n2'], ['e2', 'n1', 'n9'], ['e3', 'n9', 'n2']]));
    state.setLoaded([key('source-a')], [ref('source-a', 'type-a', 'n1'), ref('source-a', 'type-a', 'n2')], [edgeRef('source-a', 'e1'), edgeRef('source-a', 'e2'), edgeRef('source-a', 'e3')]);
    const { drawable, notDrawable } = partitionEdges(state.loadedGraph());
    expect(drawable.map((edge) => 'stableId' in edge.ref && edge.ref.stableId)).toEqual(['e1']);
    expect(notDrawable.map((edge) => 'stableId' in edge.ref && edge.ref.stableId)).toEqual(['e2', 'e3']);
  });
});

describe('the investigation refs', () => {
  it('are refused whole when any ref names another source, or when no source is bound', () => {
    const state = createClientState();
    expect(() => state.setLoaded([], [ref('source-a', 'type-a', 'n1')], [])).toThrowError(expect.objectContaining({ code: 'NO_SOURCE_BOUND' }));
    state.bindSource('source-a');
    const before = state.investigation.getState();
    expect(() => state.setLoaded([key('source-a')], [ref('source-a', 'type-a', 'n1'), ref('source-b', 'type-a', 'n2')], [])).toThrowError(expect.objectContaining({ code: 'SOURCE_MISMATCH' }));
    expect(() => state.setLoaded([key('source-a')], [ref('source-a', 'type-a', 'n1')], [edgeRef('source-b', 'e1')])).toThrowError(expect.objectContaining({ code: 'SOURCE_MISMATCH' }));
    expect(state.investigation.getState()).toBe(before);
  });
});

describe('binding another source', () => {
  it('drops the results, the refs and the presentation of the previous source, and no old result is returned', () => {
    const state = loaded();
    state.presentation.select([elementKey(ref('source-a', 'type-a', 'n1'))]);
    state.bindSource('source-b');
    expect(state.server.get(key('source-a'))).toBeUndefined();
    expect(state.server.getState().results.size).toBe(0);
    expect(state.investigation.getState()).toEqual({ sourceId: 'source-b', record: null, resultKeys: [], nodeRefs: [], edgeRefs: [] });
    expect(state.presentation.view.getState().selection.size).toBe(0);
    expect(state.loadedGraph().entities.value).toBe(0);
  });

  it('keeps everything when the same source is bound again', () => {
    const state = loaded();
    const before = state.server.getState();
    state.bindSource('source-a');
    expect(state.server.getState()).toBe(before);
    expect(state.investigation.getState().nodeRefs).toHaveLength(2);
  });
});

describe('every embedded ref is checked, and the stores cannot be written around the guards', () => {
  it('refuses a result whose relationship has an endpoint, or a nested ref, in another source, and stores nothing', () => {
    const state = createClientState();
    state.bindSource('source-a');
    const before = state.server.getState();
    const foreignEnd = { ...edge('source-a', 'e1', 'n1', 'n2'), to: ref('source-b', 'type-a', 'n2') };
    expect(() => state.putResult(key('source-a'), { sourceId: 'source-a', nodes: [node('source-a', 'n1')], edges: [foreignEnd] })).toThrowError(expect.objectContaining({ code: 'SOURCE_MISMATCH' }));
    const aggregate = { ...edge('source-a', 'e2', 'n1', 'n2'), ref: { sourceId: 'source-a', aggregate: { type: 'rel-a', from: ref('source-a', 'type-a', 'n1'), to: ref('source-b', 'type-a', 'n2') } }, memberCount: { value: 3, quality: 'exact' as const, scope: 'members' } };
    expect(() => state.putResult(key('source-a', 'agg'), { sourceId: 'source-a', nodes: [], edges: [aggregate] })).toThrowError(expect.objectContaining({ code: 'SOURCE_MISMATCH' }));
    const derived = { ...edge('source-a', 'e3', 'n1', 'n2'), ref: { sourceId: 'source-a', derived: { ruleId: 'r', from: ref('source-a', 'type-a', 'n1'), to: ref('source-b', 'type-a', 'n2') } }, semantics: 'derived' as const, derivation: { ruleId: 'r', ruleVersion: 1, supportingEdgeRefs: [edgeRef('source-b', 'x')] } };
    expect(() => state.putResult(key('source-a', 'drv'), { sourceId: 'source-a', nodes: [], edges: [derived] })).toThrowError(expect.objectContaining({ code: 'SOURCE_MISMATCH' }));
    expect(state.server.getState()).toBe(before);
  });

  it('refuses refs whose nested entities are in another source', () => {
    const state = createClientState();
    state.bindSource('source-a');
    const aggregateRef = { sourceId: 'source-a', aggregate: { type: 'rel-a', from: ref('source-a', 'type-a', 'n1'), to: ref('source-b', 'type-a', 'n2') } };
    const before = state.investigation.getState();
    expect(() => state.setLoaded([key('source-a')], [], [aggregateRef])).toThrowError(expect.objectContaining({ code: 'SOURCE_MISMATCH' }));
    expect(() => state.setLoaded([key('source-b')], [], [])).toThrowError(expect.objectContaining({ code: 'SOURCE_MISMATCH' }));
    expect(state.investigation.getState()).toBe(before);
  });

  it('gives no way to write a partition directly or to bind a source around the coordinated reset', () => {
    const state = createClientState();
    for (const store of [state.server, state.investigation, state.presentation.view, state.jobs]) {
      expect('setState' in store).toBe(false);
      expect('bind' in store).toBe(false);
      expect('put' in store).toBe(false);
    }
    expect('reset' in state.presentation).toBe(false);
  });
});

describe('panel sizes', () => {
  it.each([Number.NaN, Infinity, -Infinity, 0, -1])('refuses %s with INVALID_PANEL_SIZE and leaves the state as it was', (size) => {
    const state = createClientState();
    state.presentation.setPanelSize('inspector', 300);
    const before = state.presentation.view.getState();
    expect(() => state.presentation.setPanelSize('inspector', size)).toThrowError(expect.objectContaining({ code: 'INVALID_PANEL_SIZE' }));
    expect(state.presentation.view.getState()).toBe(before);
  });

  it('stores a finite size above zero under the panel\'s ID and clears it again, leaving the others', () => {
    const state = createClientState();
    state.presentation.setPanelSize('a', 300);
    state.presentation.setPanelSize('b', 280);
    state.presentation.clearPanelSize('a');
    expect([...state.presentation.view.getState().panelSizes]).toEqual([['b', 280]]);
  });

  it.each([
    [320.4, 320],
    [320.5, 321],
    [319.6, 320],
    [0.2, 1],
  ])('stores %s as the whole number of pixels %i, and never zero', (size, stored) => {
    const state = createClientState();
    state.presentation.setPanelSize('a', size);
    expect(state.presentation.view.getState().panelSizes.get('a')).toBe(stored);
  });

  it('clears a size that was never stored without notifying anybody', () => {
    const state = createClientState();
    const listener = vi.fn();
    state.presentation.view.subscribe(listener);
    state.presentation.clearPanelSize('nothing');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('the collapsed state of panels', () => {
  it('holds a panel collapsed under a registration number, and lets it go again, notifying only presentation state', () => {
    const state = createClientState();
    const listener = vi.fn();
    state.server.subscribe(listener);
    state.presentation.setPanelCollapsed('inspector', 3, true);
    expect(state.presentation.view.getState().collapsedPanels.get('inspector')).toBe(3);
    state.presentation.setPanelCollapsed('inspector', 3, false);
    expect(state.presentation.view.getState().collapsedPanels.has('inspector')).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('lets go of a collapsed state only for the registration it was held for, and notifies nobody when there is nothing to let go', () => {
    const state = createClientState();
    state.presentation.setPanelCollapsed('a', 2, true);
    state.presentation.setPanelCollapsed('b', 5, true);
    const listener = vi.fn();
    state.presentation.view.subscribe(listener);
    state.presentation.clearPanelCollapsed('a', 1);
    state.presentation.clearPanelCollapsed('c', 1);
    expect(listener).not.toHaveBeenCalled();
    state.presentation.clearPanelCollapsed('a', 2);
    expect([...state.presentation.view.getState().collapsedPanels]).toEqual([['b', 5]]);
  });

  it('allows an ID that is not registered, and keeps the other panels as they are', () => {
    const state = createClientState();
    state.presentation.setPanelCollapsed('a', 1, true);
    state.presentation.setPanelCollapsed('b', 2, true);
    state.presentation.setPanelCollapsed('a', 1, false);
    expect([...state.presentation.view.getState().collapsedPanels]).toEqual([['b', 2]]);
  });

  it('is kept with the sizes when another source is bound, so the viewer\'s layout is not the investigation\'s', () => {
    const state = createClientState();
    state.bindSource('source-a');
    state.presentation.setPanelCollapsed('inspector', 1, true);
    state.presentation.setPanelSize('inspector', 400);
    state.bindSource('source-b');
    expect(state.presentation.view.getState().collapsedPanels.get('inspector')).toBe(1);
    expect(state.presentation.view.getState().panelSizes.get('inspector')).toBe(400);
  });

  it('is kept when the same source is bound again, which changes nothing', () => {
    const state = createClientState();
    state.bindSource('source-a');
    state.presentation.setPanelCollapsed('inspector', 1, true);
    state.bindSource('source-a');
    expect(state.presentation.view.getState().collapsedPanels.size).toBe(1);
  });
});

describe('what the loaded graph reads', () => {
  it('is only the results the investigation names: a result cached for another principal is never used, even for the same records', () => {
    const state = createClientState();
    state.bindSource('source-a');
    const mine = key('source-a', 'seed-1');
    const theirs = { ...key('source-a', 'seed-1'), principalId: 'principal-2' };
    const renamed = { sourceId: 'source-a', nodes: [{ ...node('source-a', 'n1'), display: { title: 'their copy', type: 'type-a' } }], edges: [] };
    state.putResult(mine, result('source-a', ['n1']));
    state.putResult(theirs, renamed);
    state.setLoaded([mine], [ref('source-a', 'type-a', 'n1')], []);
    expect(state.loadedGraph().nodes.map((item) => item.display.title)).toEqual(['n1']);
    state.setLoaded([theirs], [ref('source-a', 'type-a', 'n1')], []);
    expect(state.loadedGraph().nodes.map((item) => item.display.title)).toEqual(['their copy']);
  });

  it('is empty when the investigation names no result', () => {
    const state = loaded();
    state.setLoaded([], [ref('source-a', 'type-a', 'n1')], []);
    expect(state.loadedGraph().entities.value).toBe(0);
  });
});

describe('selection of relationships', () => {
  it('works for an aggregate and a derived relationship as for a stored one', () => {
    const state = createClientState();
    state.bindSource('source-a');
    const from = ref('source-a', 'type-a', 'n1');
    const to = ref('source-a', 'type-a', 'n2');
    const aggregate = { sourceId: 'source-a', aggregate: { type: 'rel-a', from, to } };
    const derived = { sourceId: 'source-a', derived: { ruleId: 'rule-1', from, to } };
    state.setLoaded([], [from, to], [aggregate, derived]);
    state.presentation.select([edgeKey(aggregate), edgeKey(derived)]);
    expect(state.presentation.view.getState().selection.size).toBe(2);
    expect(edgeKey(aggregate)).not.toBe(edgeKey(derived));
  });
});

describe('a supporting ref in another source', () => {
  it('alone is enough to refuse a result whose endpoints and own ref are all in the bound source', () => {
    const state = createClientState();
    state.bindSource('source-a');
    const before = state.server.getState();
    const from = ref('source-a', 'type-a', 'n1');
    const to = ref('source-a', 'type-a', 'n2');
    const derived = { ...edge('source-a', 'e3', 'n1', 'n2'), ref: { sourceId: 'source-a', derived: { ruleId: 'r', from, to } }, semantics: 'derived' as const, derivation: { ruleId: 'r', ruleVersion: 1, supportingEdgeRefs: [edgeRef('source-b', 'x')] } };
    expect(() => state.putResult(key('source-a'), { sourceId: 'source-a', nodes: [node('source-a', 'n1'), node('source-a', 'n2')], edges: [derived] })).toThrowError(expect.objectContaining({ code: 'SOURCE_MISMATCH' }));
    expect(state.server.getState()).toBe(before);
    const fine = { ...derived, derivation: { ruleId: 'r', ruleVersion: 1, supportingEdgeRefs: [edgeRef('source-a', 'x')] } };
    expect(() => state.putResult(key('source-a', 'ok'), { sourceId: 'source-a', nodes: [node('source-a', 'n1'), node('source-a', 'n2')], edges: [fine] })).not.toThrow();
  });
});

describe('selection and positions', () => {
  it('select a loaded relationship of any of the three forms, and only a node can be given a position or a pin', () => {
    const state = loaded();
    const stored = edgeKey(edgeRef('source-a', 'e1'));
    state.presentation.select([stored]);
    expect([...state.presentation.view.getState().selection]).toEqual([stored]);
    expect(() => state.presentation.setPosition(stored, { x: 1, y: 1 })).toThrowError(expect.objectContaining({ code: 'UNKNOWN_ELEMENT' }));
    expect(() => state.presentation.pin([stored])).toThrowError(expect.objectContaining({ code: 'UNKNOWN_ELEMENT' }));
  });

  it('keep a node key and a relationship key apart even when an entity type is called stored', () => {
    const state = createClientState();
    state.bindSource('source-a');
    state.setLoaded([], [ref('source-a', 'stored', 'x')], []);
    const clash = edgeKey(edgeRef('source-a', 'x'));
    expect(clash).not.toBe(elementKey(ref('source-a', 'stored', 'x')));
    expect(() => state.presentation.select([clash])).toThrowError(expect.objectContaining({ code: 'UNKNOWN_ELEMENT' }));
  });

  it('drop selections, positions and pins of elements the investigation no longer holds when its refs are replaced', () => {
    const state = loaded();
    const first = elementKey(ref('source-a', 'type-a', 'n1'));
    const second = elementKey(ref('source-a', 'type-a', 'n2'));
    state.presentation.select([first, second]);
    state.presentation.setPosition(second, { x: 3, y: 4 });
    state.presentation.pin([second]);
    state.setLoaded([key('source-a')], [ref('source-a', 'type-a', 'n1')], []);
    const now = state.presentation.view.getState();
    expect([...now.selection]).toEqual([first]);
    expect(now.positions.size).toBe(0);
    expect(now.pins.size).toBe(0);
  });
});

describe('the investigation record', () => {
  const record = { title: 'Suspicious linked accounts', caseRef: null, save: { kind: 'unsaved' } } as const;

  it('is refused while no source is bound, and nothing is stored', () => {
    const state = createClientState();
    expect(() => state.describeInvestigation(record)).toThrow('NO_SOURCE_BOUND');
    expect(state.investigation.getState().record).toBeNull();
  });

  it('is refused for a save time that is not a time, and the earlier record stays', () => {
    const state = loaded();
    state.describeInvestigation(record);
    expect(() => state.describeInvestigation({ title: 'x', caseRef: null, save: { kind: 'saved', at: 'yesterday' } })).toThrow('INVALID_TIME');
    expect(state.investigation.getState().record).toBe(record);
  });

  it('is kept when the loaded refs are replaced, cleared with null, and dropped when another source is bound', () => {
    const state = loaded();
    state.describeInvestigation(record);
    state.setLoaded([key('source-a')], [ref('source-a', 'type-a', 'n1')], []);
    expect(state.investigation.getState().record).toBe(record);
    state.describeInvestigation(null);
    expect(state.investigation.getState().record).toBeNull();
    state.describeInvestigation(record);
    state.bindSource('source-b');
    expect(state.investigation.getState().record).toBeNull();
  });

  it.each(['2026-10-28T09:42:00', '2026-10-28 09:42:00Z', '2026-10-28', 'yesterday', '', '2026-02-30T09:42:00Z', '2026-02-29T09:42:00Z', '2026-13-01T09:42:00Z', '2026-10-28T24:00:00Z'])('is refused for a save time without a zone or not a time: %j, and the earlier record stays', (at) => {
    const state = loaded();
    state.describeInvestigation(record);
    expect(() => state.describeInvestigation({ title: 'x', caseRef: null, save: { kind: 'saved', at } })).toThrow('INVALID_TIME');
    expect(state.investigation.getState().record).toBe(record);
  });

  it('keeps a saved time as the same instant in UTC, whatever zone it was written in', () => {
    const state = loaded();
    state.describeInvestigation({ title: 'x', caseRef: null, save: { kind: 'saved', at: '2026-10-29T01:30:00+02:00' } });
    expect(state.investigation.getState().record?.save).toEqual({ kind: 'saved', at: '2026-10-28T23:30:00.000Z' });
  });
});
