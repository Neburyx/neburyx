import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { elementKey } from '../state/keys.js';
import { edge, node, ref } from '../state/test-data.js';
import { aggregateKey } from '../workspace/aggregate-nodes.js';
import { loadGraph, nodeKey } from '../workspace/context-menu-kit.js';
import { answerPreview, count, inPanel, panelRig, previewOf } from '../workspace/supernode-kit.js';
import { registerBuiltInKeyBindings } from '../workspace/built-in-key-bindings.js';
import { createKeyListener } from '../workspace/key-binding-handler.js';
import { createKeyBindingRegistry } from '../workspace/key-binding-registry.js';
import type { Scene } from './scene.js';

afterEach(() => cleanup());

const preview = previewOf({ byNeighborType: [{ entityType: 'kind-b', count: count(15, 'exact') }, { entityType: 'type-c', count: count(3300, 'lowerBound') }] });
const n1 = nodeKey('n1');
const lastScene = (rig: ReturnType<typeof panelRig>): Scene | undefined => rig.shown.factory.made[0]?.scenes.at(-1);
const remainders = (rig: ReturnType<typeof panelRig>) => lastScene(rig)?.entities.filter((entity) => entity.remainder === true) ?? [];
const events = (rig: ReturnType<typeof panelRig>) => {
  const held = rig.shown.factory.made[0]?.events[0];
  if (held === undefined) throw new Error('the renderer was not mounted');
  return held;
};

async function drawn() {
  const rig = panelRig();
  await rig.open('n1');
  await answerPreview(rig.previews[0], preview);
  return rig;
}

describe('the aggregate nodes on the canvas', () => {
  it('are drawn for a node opened in the panel once its preview is held, and made no request by drawing', async () => {
    const rig = panelRig();
    await rig.open('n1');
    expect(remainders(rig)).toEqual([]);
    await answerPreview(rig.previews[0], preview);
    expect(remainders(rig).map((entity) => [entity.look.line1, entity.look.line2, entity.look.tip?.title])).toEqual([['kind-b', '0 / 15', 'kind-b · 0 / 15'], ['type-c', '0 / ≥ 3,300', 'type-c · 0 / ≥ 3,300']]);
    expect(rig.previews).toHaveLength(1);
    expect(rig.expansions).toHaveLength(0);
  });

  it('are not drawn for a node whose preview is not held, even when it was expanded, and expanding asks for no preview', async () => {
    const rig = panelRig();
    void rig.expand.expand(ref('a', 'type-a', 'n2'), ['kind-b']);
    await act(async () => undefined);
    expect(remainders(rig)).toEqual([]);
    expect(rig.previews).toHaveLength(0);
  });

  it('are drawn for no node when the masking setting changes, since its previews are another setting\'s', async () => {
    const rig = await drawn();
    expect(remainders(rig)).toHaveLength(2);
    act(() => rig.state.setMask(true));
    expect(remainders(rig)).toEqual([]);
  });

  it('are not drawn for a node that is hidden, leave the walk and the scene items with it, and come back when it is shown', async () => {
    const rig = await drawn();
    expect(remainders(rig)).toHaveLength(2);
    act(() => rig.state.hide([n1]));
    expect(remainders(rig)).toEqual([]);
    expect(rig.state.presentation.view.getState().sceneItems).toEqual([]);
    act(() => rig.state.presentation.showAllHidden());
    expect(remainders(rig)).toHaveLength(2);
  });

  it('keep the loaded figures of another entity when a hidden entity is one of its loaded neighbors, since hidden entities stay loaded', async () => {
    const rig = panelRig();
    loadGraph(rig.state, [node('a', 'n1'), node('a', 'n2')], [edge('a', 'e1', 'n1', 'n2')]);
    await rig.open('n1');
    await rig.open('n2');
    const both = previewOf({ byNeighborType: [{ entityType: 'type-a', count: count(15, 'exact') }] });
    await answerPreview(rig.previews[0], both);
    await answerPreview(rig.previews[1], both);
    const figures = (): Array<readonly [string, string | undefined]> => remainders(rig).map((entity) => [entity.id, entity.look.line2]);
    const before = figures();
    expect(before.map(([, line2]) => line2)).toEqual(['1 / 15', '1 / 15']);
    act(() => rig.state.hide([n1]));
    expect(figures()).toEqual(before.filter(([id]) => id !== aggregateKey(n1, 'type-a')));
  });

  it('are told in the description of the canvas, and not counted among the entities', async () => {
    await drawn();
    const description = document.querySelector('.visually-hidden')?.textContent ?? '';
    expect(description).toContain('2 entities and 0 relationships loaded');
    expect(description).toContain('2 aggregate nodes for relationships not loaded');
  });

  it('cannot be selected, pinned or positioned, are ignored by a box, and do nothing when dragged', async () => {
    const rig = await drawn();
    const id = aggregateKey(n1, 'kind-b');
    expect(() => rig.state.presentation.select([id])).toThrow();
    expect(() => rig.state.presentation.pin([id])).toThrow();
    expect(() => rig.state.presentation.setPosition(id, { x: 1, y: 1 })).toThrow();
    act(() => events(rig).box({ ids: [n1, id], shift: false }));
    expect([...rig.state.presentation.view.getState().selection]).toEqual([n1]);
    const before = rig.state.presentation.view.getState().positions;
    act(() => events(rig).move({ id, position: { x: 5, y: 5 } }));
    expect(rig.state.presentation.view.getState().positions).toBe(before);
  });

  it('open the panel of their node with that type alone ticked when clicked, without changing the selection', async () => {
    const rig = await drawn();
    act(() => rig.state.presentation.setSupernodePanel(undefined));
    const selected = rig.state.presentation.view.getState().selection;
    act(() => events(rig).click({ target: aggregateKey(n1, 'type-c'), shift: false }));
    expect(rig.state.presentation.view.getState().supernodePanel).toEqual({ key: n1, neighborType: 'type-c' });
    expect(rig.state.presentation.view.getState().selection).toBe(selected);
    await act(async () => undefined);
    expect(inPanel().getAllByRole('checkbox').map((row) => [row.textContent, row.getAttribute('aria-checked')])).toEqual([['kind-b15 · exact', 'false'], ['type-c≥ 3,300 · lower bound', 'true']]);
  });

  it('open the panel and select nothing when clicked with the toggle modifier held, as a plain click does', async () => {
    const rig = await drawn();
    act(() => rig.state.presentation.setSupernodePanel(undefined));
    const selected = rig.state.presentation.view.getState().selection;
    act(() => events(rig).click({ target: aggregateKey(n1, 'type-c'), shift: false, toggle: true }));
    expect(rig.state.presentation.view.getState().supernodePanel).toEqual({ key: n1, neighborType: 'type-c' });
    expect(rig.state.presentation.view.getState().selection).toBe(selected);
  });

  it('give the menu of their node on a right click', async () => {
    const rig = await drawn();
    act(() => events(rig).contextMenu({ target: { kind: 'node', key: aggregateKey(n1, 'kind-b') }, x: 10, y: 10 }));
    expect(screen.getByRole('menu', { name: 'n1' })).not.toBeNull();
  });

  it('are reached by the walk after the relationships, announced with their loaded counts, and open the panel on Enter', async () => {
    const rig = await drawn();
    const first = aggregateKey(n1, 'kind-b');
    expect(rig.state.presentation.view.getState().sceneItems).toEqual([first, aggregateKey(n1, 'type-c')]);
    act(() => rig.state.presentation.setSupernodePanel(undefined));
    document.querySelector<HTMLElement>('.graph-canvas')?.focus();
    act(() => rig.state.presentation.walkTo(first));
    expect(screen.getByText('kind-b: 0 of 15 relationships loaded, not all loaded')).not.toBeNull();
    expect(lastScene(rig)?.focused).toBe(first);
    const registry = createKeyBindingRegistry('mac');
    registerBuiltInKeyBindings(registry);
    const listener = createKeyListener(registry, () => ({ state: rig.state, canvas: undefined, expansion: undefined }));
    const canvas = document.querySelector<HTMLElement>('.graph-canvas');
    canvas?.addEventListener('keydown', listener);
    act(() => void canvas?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(rig.state.presentation.view.getState().supernodePanel).toEqual({ key: n1, neighborType: 'kind-b' });
  });

  it('are left by the walk when they are gone', async () => {
    const rig = await drawn();
    const id = aggregateKey(n1, 'kind-b');
    act(() => rig.state.presentation.walkTo(id));
    act(() => rig.state.setMask(true));
    expect(rig.state.presentation.view.getState().focused).toBeUndefined();
    expect(elementKey(ref('a', 'type-a', 'n1'))).toBe(n1);
  });
});
