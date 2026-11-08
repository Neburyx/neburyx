import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { elementKey } from '../state/keys.js';
import { edge, key, node, ref } from '../state/test-data.js';
import { stubFactory } from '../test-utils.js';
import { answerPreview, count, panelRig, previewOf } from '../workspace/supernode-kit.js';
import { GraphCanvas } from './graph-canvas.js';
import { RendererProvider } from './renderer-context.js';
import type { Scene } from './scene.js';
import { entitiesInBox } from './box-selection.js';
import { runSelectionCommand } from './selection-commands.js';
import { walkOrder } from './walk.js';

afterEach(() => cleanup());

const keyOf = (id: string, type: string): string => elementKey(ref('a', type, id));
const typed = (id: string, type: string) => ({ ...node('a', id), ref: ref('a', type, id) });

function load(): ClientState {
  const state = createClientState();
  const nodes = [typed('n0', 'kind-a'), typed('n1', 'kind-a'), typed('n2', 'kind-b')];
  const link = (id: string, from: [string, string], to: [string, string]) => ({ ...edge('a', id, from[0], to[0]), from: ref('a', from[1], from[0]), to: ref('a', to[1], to[0]) });
  const edges = [link('e0', ['n0', 'kind-a'], ['n1', 'kind-a']), link('e1', ['n1', 'kind-a'], ['n2', 'kind-b'])];
  state.bindSource('a');
  state.putResult(key('a'), { sourceId: 'a', nodes, edges });
  state.setLoaded([key('a')], nodes.map((candidate) => candidate.ref), edges.map((candidate) => candidate.ref));
  state.presentation.setMappedTypes({ entityTypes: ['kind-a', 'kind-b'], relationshipTypes: [] });
  return state;
}

describe('entity types switched off, on the canvas', () => {
  it('draws no entity of an off type and no relationship that touches one, and moves nothing else', () => {
    const state = load();
    const factory = stubFactory();
    render(
      <ClientStateProvider state={state}>
        <RendererProvider createRenderer={factory.create}>
          <GraphCanvas />
        </RendererProvider>
      </ClientStateProvider>,
    );
    const renderer = factory.made[0];
    const before = new Map(renderer?.scenes.at(-1)?.entities.map((entity) => [entity.id, entity.position]));
    act(() => state.setEntityTypeOff('kind-b', true));
    const scene = renderer?.scenes.at(-1);
    expect(scene?.entities.map((entity) => entity.id)).toEqual([keyOf('n0', 'kind-a'), keyOf('n1', 'kind-a')]);
    expect(scene?.relationships).toHaveLength(1);
    for (const entity of scene?.entities ?? []) expect(entity.position).toEqual(before.get(entity.id));
    act(() => state.setEntityTypeOff('kind-a', true));
    expect(renderer?.scenes.at(-1)?.entities).toEqual([]);
    act(() => state.presentation.resetTypeFilter());
    expect(renderer?.scenes.at(-1)?.entities).toHaveLength(3);
  });
});

describe('entity types switched off, and the commands', () => {
  it('leave the walk, Select all, Invert selection and a box with the drawn entities and relationships only', () => {
    const state = load();
    state.setEntityTypeOff('kind-b', true);
    expect(walkOrder(state.visibleGraph()).filter((entry) => entry.includes('n2'))).toEqual([]);
    expect(walkOrder(state.visibleGraph()).slice(0, 2)).toEqual([keyOf('n0', 'kind-a'), keyOf('n1', 'kind-a')]);
    runSelectionCommand(state, 'select-all');
    expect([...state.presentation.view.getState().selection]).toEqual([keyOf('n0', 'kind-a'), keyOf('n1', 'kind-a')]);
    state.presentation.select([keyOf('n0', 'kind-a')]);
    runSelectionCommand(state, 'invert-selection');
    expect([...state.presentation.view.getState().selection]).toEqual([keyOf('n1', 'kind-a')]);
    const factory = stubFactory();
    render(
      <ClientStateProvider state={state}>
        <RendererProvider createRenderer={factory.create}>
          <GraphCanvas />
        </RendererProvider>
      </ClientStateProvider>,
    );
    const centres = new Map((factory.made[0]?.scenes.at(-1)?.entities ?? []).map((entity) => [entity.id, entity.position] as const));
    expect([...centres.keys()].sort()).toEqual([keyOf('n0', 'kind-a'), keyOf('n1', 'kind-a')].sort());
    expect(entitiesInBox(centres, { x1: -1e6, y1: -1e6, x2: 1e6, y2: 1e6 }).sort()).toEqual([...centres.keys()].sort());
  });
});

describe('entity types switched off, and the aggregate nodes', () => {
  const preview = previewOf({ byNeighborType: [{ entityType: 'kind-b', count: count(15, 'exact') }, { entityType: 'type-c', count: count(3300, 'lowerBound') }] });
  const lastScene = (rig: ReturnType<typeof panelRig>): Scene | undefined => rig.shown.factory.made[0]?.scenes.at(-1);
  const remainders = (rig: ReturnType<typeof panelRig>) => lastScene(rig)?.entities.filter((entity) => entity.remainder === true) ?? [];

  async function drawn() {
    const rig = panelRig();
    rig.state.presentation.setMappedTypes({ entityTypes: ['type-a', 'kind-b', 'type-c'], relationshipTypes: [] });
    await rig.open('n1');
    await answerPreview(rig.previews[0], preview);
    return rig;
  }

  it('are not drawn when their neighbor type is off, and come back when it is on, with the same figures', async () => {
    const rig = await drawn();
    const before = remainders(rig).map((entity) => [entity.id, entity.look.line2]);
    expect(before).toHaveLength(2);
    act(() => rig.state.setEntityTypeOff('kind-b', true));
    expect(remainders(rig).map((entity) => entity.look.line1)).toEqual(['type-c']);
    act(() => rig.state.setEntityTypeOff('kind-b', false));
    expect(remainders(rig).map((entity) => [entity.id, entity.look.line2])).toEqual(before);
  });

  it('are not drawn for an owner whose own type is off, and the walk has no scene item for them', async () => {
    const rig = await drawn();
    act(() => rig.state.setEntityTypeOff('type-a', true));
    expect(remainders(rig)).toEqual([]);
    expect(rig.state.presentation.view.getState().sceneItems).toEqual([]);
  });
});
