import { act, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { edge, node } from '../state/test-data.js';
import { aggregateKey } from '../workspace/aggregate-nodes.js';
import { loadGraph, nodeKey } from '../workspace/context-menu-kit.js';
import { answerPreview, count, panelRig, previewOf } from '../workspace/supernode-kit.js';
import { elementKey } from '../state/keys.js';
import { runSelectionCommand } from './selection-commands.js';
import { stepWalk, walkOrder } from './walk.js';
import type { Scene } from './scene.js';

afterEach(() => cleanup());

const preview = previewOf({ byNeighborType: [{ entityType: 'kind-b', count: count(15, 'exact') }] });
const [n1, n2, n3, n4, n5] = ['n1', 'n2', 'n3', 'n4', 'n5'].map(nodeKey) as [string, string, string, string, string];
const lastScene = (rig: ReturnType<typeof panelRig>): Scene | undefined => rig.shown.factory.made[0]?.scenes.at(-1);

async function rigWithChain() {
  const rig = panelRig();
  loadGraph(rig.state, [node('a', 'n1'), node('a', 'n2'), node('a', 'n3'), node('a', 'n4')], [edge('a', 'e1', 'n1', 'n2'), edge('a', 'e2', 'n2', 'n3'), edge('a', 'e3', 'n3', 'n4')]);
  await rig.open('n1');
  await rig.open('n3');
  await answerPreview(rig.previews[0], preview);
  await answerPreview(rig.previews[1], preview);
  return rig;
}

describe('the neighborhood focus on the canvas', () => {
  it('draws the focused entity and its neighbors and no aggregate node while focus is on, draws them all again on leaving, and asks for nothing', async () => {
    const rig = await rigWithChain();
    const requests = [rig.previews.length, rig.expansions.length];
    expect(lastScene(rig)?.entities.filter((entity) => entity.remainder === true).map((entity) => entity.id)).toEqual([aggregateKey(n1, 'kind-b'), aggregateKey(n3, 'kind-b')]);
    act(() => rig.state.focusOn(n1));
    expect(lastScene(rig)?.entities.filter((entity) => entity.remainder !== true).map((entity) => entity.id)).toEqual([n1, n2]);
    expect(lastScene(rig)?.entities.filter((entity) => entity.remainder === true)).toEqual([]);
    const drawn = new Set(lastScene(rig)?.entities.map((entity) => entity.id));
    expect(lastScene(rig)?.relationships.filter((link) => !drawn.has(link.from) || !drawn.has(link.to))).toEqual([]);
    expect(rig.state.presentation.view.getState().sceneItems).toEqual([]);
    act(() => rig.state.focusOn(n3));
    expect(lastScene(rig)?.entities.filter((entity) => entity.remainder !== true).map((entity) => entity.id)).toEqual([n2, n3, n4]);
    act(() => rig.state.presentation.leaveFocus());
    expect(lastScene(rig)?.entities.filter((entity) => entity.remainder !== true)).toHaveLength(4);
    expect(lastScene(rig)?.entities.filter((entity) => entity.remainder === true).map((entity) => entity.id)).toEqual([aggregateKey(n1, 'kind-b'), aggregateKey(n3, 'kind-b')]);
    expect([rig.previews.length, rig.expansions.length]).toEqual(requests);
  });

  it('keeps drawing no placeholder when the loaded graph changes inside focus, and on leaving draws those of the graph as it is then, with no count changed', async () => {
    const rig = await rigWithChain();
    const loadedCount = (): number => rig.state.investigation.getState().nodeRefs.length;
    const requests = [rig.previews.length, rig.expansions.length];
    act(() => rig.state.focusOn(n1));
    await rig.open('n2');
    await answerPreview(rig.previews[2], preview);
    const remainders = () => lastScene(rig)?.entities.filter((entity) => entity.remainder === true).map((entity) => entity.id);
    expect(remainders()).toEqual([]);
    expect(rig.state.presentation.view.getState().sceneItems).toEqual([]);
    expect(loadedCount()).toBe(4);
    act(() => rig.state.presentation.leaveFocus());
    expect(remainders()).toEqual([aggregateKey(n1, 'kind-b'), aggregateKey(n2, 'kind-b'), aggregateKey(n3, 'kind-b')]);
    act(() => rig.state.focusOn(n1));
    act(() => rig.state.setLoaded(rig.state.investigation.getState().resultKeys, rig.state.investigation.getState().nodeRefs.filter((candidate) => elementKey(candidate) !== n3), rig.state.investigation.getState().edgeRefs.filter((candidate) => 'stableId' in candidate && candidate.stableId === 'e1')));
    expect(remainders()).toEqual([]);
    act(() => rig.state.presentation.leaveFocus());
    expect(remainders()).toEqual([aggregateKey(n1, 'kind-b'), aggregateKey(n2, 'kind-b')]);
    expect(loadedCount()).toBe(3);
    expect([rig.previews.length, rig.expansions.length]).toEqual([(requests[0] ?? 0) + 1, requests[1]]);
  });

  it('moves the walk off a placeholder when focus starts, and holds no placeholder in the walk order', async () => {
    const rig = await rigWithChain();
    act(() => rig.state.presentation.walkTo(aggregateKey(n1, 'kind-b')));
    expect(rig.state.presentation.view.getState().focused).toBe(aggregateKey(n1, 'kind-b'));
    act(() => rig.state.focusOn(n1));
    expect(rig.state.presentation.view.getState().focused).toBeUndefined();
    const order = walkOrder(rig.state.visibleGraph(), rig.state.presentation.view.getState().sceneItems);
    expect(order).not.toContain(aggregateKey(n1, 'kind-b'));
    expect(order).not.toContain(aggregateKey(n3, 'kind-b'));
    expect(order).toContain(n2);
  });

  it('leaves the walk, select all and invert selection with the drawn entities only', async () => {
    const rig = await rigWithChain();
    act(() => rig.state.focusOn(n1));
    const state = rig.state;
    expect(walkOrder(state.visibleGraph()).filter((key) => key === n3 || key === n4)).toEqual([]);
    expect(stepWalk(walkOrder(state.visibleGraph()), n1, 1)).toBe(n2);
    runSelectionCommand(state, 'select-all');
    expect([...state.presentation.view.getState().selection]).toEqual([n1, n2]);
    state.presentation.select([n1]);
    runSelectionCommand(state, 'invert-selection');
    expect([...state.presentation.view.getState().selection]).toEqual([n2]);
  });

  it('fits the view once each time focus is put on an entity, and not when focus ends with a viewport held', async () => {
    const rig = await rigWithChain();
    const renderer = rig.shown.factory.made[0];
    const fits = (): number => renderer?.fits ?? 0;
    act(() => rig.state.presentation.setViewport({ zoom: 2, x: 1, y: 1 }));
    const start = fits();
    act(() => rig.state.focusOn(n1));
    expect(fits()).toBe(start + 1);
    expect(renderer?.entityFits).toBe(1);
    act(() => rig.state.focusOn(n2));
    expect(fits()).toBe(start + 2);
    act(() => rig.state.presentation.leaveFocus());
    expect(fits()).toBe(start + 2);
  });

  it('fits at once when focus sets nothing aside, fits again when focus is left with no viewport held, and not otherwise or after a source is bound', async () => {
    const rig = panelRig();
    loadGraph(rig.state, [node('a', 'n1'), node('a', 'n2')], [edge('a', 'e1', 'n1', 'n2')]);
    await rig.open('n1');
    const renderer = rig.shown.factory.made[0];
    const start = renderer?.fits ?? 0;
    act(() => rig.state.focusOn(n1));
    expect(renderer?.fits).toBe(start + 1);
    act(() => rig.state.presentation.leaveFocus());
    expect(renderer?.fits).toBe(start + 2);
    act(() => rig.state.presentation.select([n1]));
    act(() => rig.state.presentation.setPosition(n1, { x: 3, y: 3 }));
    expect(renderer?.fits).toBe(start + 2);
    act(() => rig.state.bindSource('b'));
    expect(renderer?.fits).toBe(start + 2);
  });

  it('shows the viewport from before focus on the renderer when focus is left, when the focused entity is hidden and when it is no longer loaded, and fits when none was held', async () => {
    const rig = await rigWithChain();
    const renderer = rig.shown.factory.made[0];
    const held = { zoom: 2, x: 5, y: 6 };
    act(() => rig.state.presentation.setViewport(held));
    act(() => rig.state.focusOn(n1));
    act(() => rig.state.presentation.leaveFocus());
    expect(renderer?.shown.at(-1)).toEqual(held);
    act(() => rig.state.focusOn(n2));
    act(() => rig.state.hide([n2]));
    expect(renderer?.shown).toHaveLength(2);
    expect(renderer?.shown.at(-1)).toEqual(held);
    act(() => rig.state.presentation.showAllHidden());
    act(() => rig.state.focusOn(n3));
    const refs = rig.state.investigation.getState();
    act(() => rig.state.setLoaded(refs.resultKeys, refs.nodeRefs.filter((candidate) => elementKey(candidate) !== n3), []));
    expect(renderer?.shown).toHaveLength(3);
  });

  it('places an entity that was loaded during focus and never drawn when focus is left, and moves no entity that has a position', async () => {
    const rig = await rigWithChain();
    act(() => rig.state.focusOn(n1));
    const before = new Map(rig.state.presentation.view.getState().positions);
    loadGraph(rig.state, [node('a', 'n1'), node('a', 'n2'), node('a', 'n3'), node('a', 'n4'), node('a', 'n5')], [edge('a', 'e1', 'n1', 'n2'), edge('a', 'e2', 'n2', 'n3'), edge('a', 'e3', 'n3', 'n4'), edge('a', 'e4', 'n4', 'n5')]);
    expect(rig.state.presentation.view.getState().positions.has(n5)).toBe(false);
    act(() => rig.state.presentation.leaveFocus());
    const after = rig.state.presentation.view.getState().positions;
    expect(after.has(n5)).toBe(true);
    for (const [id, position] of before) expect(after.get(id)).toEqual(position);
  });

  it('selects nothing that focus sets aside from a box, and frames only what is drawn', async () => {
    const rig = await rigWithChain();
    act(() => rig.state.focusOn(n1));
    const events = rig.shown.factory.made[0]?.events[0];
    act(() => events?.box({ ids: [n1, n2, n3, n4], additive: false, subtractive: false } as never));
    expect([...rig.state.presentation.view.getState().selection]).toEqual([n1, n2]);
    expect(rig.shown.factory.made[0]?.scenes.at(-1)?.entities.filter((entity) => entity.remainder !== true).map((entity) => entity.id)).toEqual([n1, n2]);
  });

  it('takes no read: no job is started', async () => {
    const rig = await rigWithChain();
    const jobs = rig.state.jobs.getState();
    act(() => rig.state.focusOn(n1));
    act(() => rig.state.presentation.leaveFocus());
    expect(rig.state.jobs.getState()).toBe(jobs);
  });
});
