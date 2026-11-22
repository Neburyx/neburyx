import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { cardKey, containerKey } from '../groups/group-keys.js';
import { entityOf, keyOf, linkOf, loadedState, at } from '../groups/group-kit.js';
import { ClientStateProvider } from '../state/context.js';
import type { ClientState } from '../state/client-state.js';
import { stubFactory } from '../test-utils.js';
import { GraphCanvas } from './graph-canvas.js';
import { RendererProvider } from './renderer-context.js';

afterEach(cleanup);

const devices = [entityOf('kind-d', 'DV1'), entityOf('kind-d', 'DV2')];
const accounts = [entityOf('kind-a', 'A1'), entityOf('kind-a', 'A2')];
const links = [linkOf('L1', at(accounts, 0), at(devices, 0)), linkOf('L2', at(accounts, 1), at(devices, 0))];

function draw(state: ClientState) {
  const factory = stubFactory();
  render(
    <ClientStateProvider state={state}>
      <RendererProvider createRenderer={factory.create}>
        <GraphCanvas profile={undefined} />
      </RendererProvider>
    </ClientStateProvider>,
  );
  const [renderer] = factory.made;
  if (renderer === undefined) throw new Error('no renderer');
  const last = () => renderer.scenes.at(-1);
  return { renderer, last };
}

const groupOf = (id: string, members: readonly ReturnType<typeof entityOf>[], collapsed: boolean) => ({ id, by: 'entityType', members: members.map(keyOf), collapsed });

describe('the canvas with groups', () => {
  it('draws a collapsed group as one card and none of its members, with the relationships to it merged and counted', () => {
    const state = loadedState([...devices, ...accounts], links);
    const { last } = draw(state);
    const before = last()?.entities.length;
    act(() => state.presentation.setGroups([groupOf('type:kind-a', accounts, true)]));
    expect(before).toBe(4);
    const scene = last();
    expect(scene?.entities.map((entity) => entity.id).sort()).toEqual([cardKey('type:kind-a'), keyOf(at(devices, 0)), keyOf(at(devices, 1))].sort());
    expect(scene?.relationships.map((relationship) => [relationship.from, relationship.to, relationship.look.label])).toEqual([[cardKey('type:kind-a'), keyOf(at(devices, 0)), '×2']]);
  });

  it('draws an expanded group as a container around its members, and no card', () => {
    const state = loadedState([...devices, ...accounts], links);
    const { last } = draw(state);
    act(() => state.presentation.setGroups([groupOf('type:kind-d', devices, false)]));
    expect(last()?.containers).toEqual([{ id: containerKey('type:kind-d'), label: 'kind-d · 2 loaded', members: devices.map(keyOf) }]);
    expect(last()?.entities).toHaveLength(4);
  });

  it('expands a group when its card is clicked and selects nothing', () => {
    const state = loadedState([...devices, ...accounts], links);
    const { renderer } = draw(state);
    act(() => state.presentation.setGroups([groupOf('type:kind-a', accounts, true)]));
    act(() => renderer.events[0]?.click({ target: cardKey('type:kind-a'), shift: false }));
    expect(state.presentation.view.getState().groups[0]?.collapsed).toBe(false);
    expect(state.presentation.view.getState().selection.size).toBe(0);
  });

  it('moves the members that are not pinned by the offset of a dragged card, and writes no pin or hidden state', () => {
    const state = loadedState([...devices, ...accounts], links);
    const { renderer, last } = draw(state);
    state.presentation.pin([keyOf(at(accounts, 1))]);
    act(() => state.presentation.setGroups([groupOf('type:kind-a', accounts, true)]));
    const first = state.presentation.view.getState().positions.get(keyOf(at(accounts, 0)));
    const pinned = state.presentation.view.getState().positions.get(keyOf(at(accounts, 1)));
    const card = last()?.entities.find((entity) => entity.id === cardKey('type:kind-a'));
    if (first === undefined || card === undefined || pinned === undefined) throw new Error('no positions');
    act(() => renderer.events[0]?.move({ id: cardKey('type:kind-a'), position: { x: card.position.x + 40, y: card.position.y - 10 } }));
    const after = state.presentation.view.getState();
    expect(after.positions.get(keyOf(at(accounts, 0)))?.x).toBeCloseTo(first.x + 40, 6);
    expect(after.positions.get(keyOf(at(accounts, 0)))?.y).toBeCloseTo(first.y - 10, 6);
    expect(after.positions.get(keyOf(at(accounts, 1)))).toEqual(pinned);
    expect([...after.pins]).toEqual([keyOf(at(accounts, 1))]);
    expect(after.hidden.size).toBe(0);
  });

  it('draws no card for a group whose members are all hidden, and keeps the group', () => {
    const state = loadedState([...devices, ...accounts], links);
    const { last } = draw(state);
    state.hide(accounts.map(keyOf));
    act(() => state.presentation.setGroups([groupOf('type:kind-a', accounts, true)]));
    expect(last()?.entities.some((entity) => entity.group !== undefined)).toBe(false);
    expect(state.presentation.view.getState().groups).toHaveLength(1);
  });

  it('puts the members back where they were when the groups are removed', () => {
    const state = loadedState([...devices, ...accounts], links);
    const { last } = draw(state);
    const at = new Map(last()?.entities.map((entity) => [entity.id, entity.position]));
    act(() => state.presentation.setGroups([groupOf('type:kind-a', accounts, true)]));
    act(() => state.presentation.setGroups([]));
    expect(new Map(last()?.entities.map((entity) => [entity.id, entity.position]))).toEqual(at);
  });
});
