import { describe, expect, it, vi } from 'vitest';
import type { TemplateRunOk } from '@neburyx/contracts';
import { createClientState } from '../state/client-state.js';
import { typedNode } from '../workspace/filters-kit.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import { key, ref, result } from '../state/test-data.js';
import { okRun } from './patterns-kit.js';
import { addResultToGraph } from './add-to-graph.js';

describe('addResultToGraph', () => {
  it('keeps the entities that were held so that no collapse takes them away, and adds nothing twice', () => {
    const state = createClientState();
    loadGraph(state, [typedNode('acc-1', 'kind-a'), typedNode('acc-2', 'kind-a')], []);
    const keep = vi.fn();
    const result = okRun(['acc-3']) as TemplateRunOk;
    const outcome = addResultToGraph(state, result, { sourceId: 'a', principalId: 'p', mask: false, expansions: { keep } });
    expect(outcome.heldEntities).toBeGreaterThan(0);
    expect(keep).toHaveBeenCalledWith(ref('a', 'kind-a', 'acc-1'));
    const before = JSON.stringify(state.loadedGraph());
    const setLoaded = vi.spyOn(state, 'setLoaded');
    expect(addResultToGraph(state, result, { sourceId: 'a', principalId: 'p', mask: false })).toMatchObject({ entities: 0, relationships: 0 });
    expect(setLoaded).not.toHaveBeenCalled();
    expect(JSON.stringify(state.loadedGraph())).toBe(before);
  });
});

describe('adding a result read with the other masking setting', () => {
  it('is refused before anything is stored, whatever key the merge would stamp', () => {
    const state = createClientState();
    loadGraph(state, [typedNode('acc-1', 'kind-a')], []);
    state.setMask(true);
    state.finishMaskRead({ key: { ...key('a', 'again'), mask: true }, result: result('a', ['acc-1']), nodeRefs: [ref('a', 'type-a', 'acc-1')], edgeRefs: [] });
    const before = JSON.stringify(state.loadedGraph());
    const setLoaded = vi.spyOn(state, 'setLoaded');
    const run = okRun(['acc-3']);
    if (run.status !== 'ok') throw new Error('not ok');
    expect(() => addResultToGraph(state, run, { sourceId: 'a', principalId: 'p', mask: false })).toThrowError(expect.objectContaining({ code: 'MASK_CHANGED' }));
    expect(setLoaded).not.toHaveBeenCalled();
    expect(JSON.stringify(state.loadedGraph())).toBe(before);
  });
});
