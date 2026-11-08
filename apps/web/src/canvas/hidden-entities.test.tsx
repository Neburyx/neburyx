import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { edgeRef, key, ref, result } from '../state/test-data.js';
import { stubFactory } from '../test-utils.js';
import { GraphCanvas } from './graph-canvas.js';
import { RendererProvider } from './renderer-context.js';
import { useCanvasCommands } from './canvas-commands.js';
import { runSelectionCommand } from './selection-commands.js';
import { stepWalk, walkOrder } from './walk.js';
import type { CreateRenderer } from './scene.js';

const nodeKey = (id: string): string => elementKey(ref('a', 'type-a', id));
const linkKey = (id: string): string => edgeKey(edgeRef('a', id));

function load(): ClientState {
  const state = createClientState();
  const ids = ['n0', 'n1', 'n2', 'n3'];
  const links: Array<[string, string, string]> = [['e0', 'n0', 'n1'], ['e1', 'n1', 'n2'], ['e2', 'n2', 'n3']];
  state.bindSource('a');
  state.putResult(key('a'), result('a', ids, links));
  state.setLoaded([key('a')], ids.map((id) => ref('a', 'type-a', id)), links.map(([id]) => edgeRef('a', id)));
  return state;
}

function view(state: ClientState, create: CreateRenderer) {
  return render(
    <ClientStateProvider state={state}>
      <RendererProvider createRenderer={create}>
        <GraphCanvas />
      </RendererProvider>
    </ClientStateProvider>,
  );
}

describe('hiding entities', () => {
  it('keeps hidden entities where they are through a layout, and walks on from the canvas when the entity the walk stood on is hidden', () => {
    const state = load();
    let commands: ReturnType<typeof useCanvasCommands>;
    function Capture() {
      commands = useCanvasCommands();
      return null;
    }
    const factory = stubFactory();
    render(
      <ClientStateProvider state={state}>
        <RendererProvider createRenderer={factory.create}>
          <GraphCanvas />
          <Capture />
        </RendererProvider>
      </ClientStateProvider>,
    );
    act(() => state.hide([nodeKey('n1')]));
    const before = state.presentation.view.getState().positions.get(nodeKey('n1'));
    act(() => state.presentation.setPosition(nodeKey('n2'), { x: 40_000, y: -40_000 }));
    act(() => commands?.layout());
    expect(state.presentation.view.getState().positions.get(nodeKey('n1'))).toEqual(before);
    expect(state.presentation.view.getState().positions.get(nodeKey('n2'))).not.toEqual({ x: 40_000, y: -40_000 });
    state.presentation.walkTo(nodeKey('n2'));
    act(() => state.hide([nodeKey('n2')]));
    expect(state.presentation.view.getState().focused).toBeUndefined();
    expect(stepWalk(walkOrder(state.visibleGraph()), state.presentation.view.getState().focused, 1)).toBe(nodeKey('n0'));
  });

  it('draws no hidden entity and no relationship that touches one, and moves nothing else', () => {
    const state = load();
    const factory = stubFactory();
    view(state, factory.create);
    const renderer = factory.made[0];
    const before = new Map(renderer?.scenes.at(-1)?.entities.map((entity) => [entity.id, entity.position]));
    act(() => state.hide([nodeKey('n1')]));
    const scene = renderer?.scenes.at(-1);
    expect(scene?.entities.map((entity) => entity.id)).toEqual([nodeKey('n0'), nodeKey('n2'), nodeKey('n3')]);
    expect(scene?.relationships.map((relationship) => relationship.id)).toEqual([linkKey('e2')]);
    for (const entity of scene?.entities ?? []) expect(entity.position).toEqual(before.get(entity.id));
    expect(state.loadedGraph().nodes).toHaveLength(4);
    act(() => state.presentation.showAllHidden());
    expect(renderer?.scenes.at(-1)?.entities).toHaveLength(4);
  });

  it('draws an empty canvas, without an error, when everything is hidden', () => {
    const state = load();
    const factory = stubFactory();
    view(state, factory.create);
    act(() => state.hide(['n0', 'n1', 'n2', 'n3'].map(nodeKey)));
    expect(factory.made[0]?.scenes.at(-1)?.entities).toEqual([]);
  });

  it('leaves the walk, select all and invert selection with the drawn entities only', () => {
    const state = load();
    state.hide([nodeKey('n1')]);
    expect(walkOrder(state.visibleGraph())).toEqual([nodeKey('n0'), nodeKey('n2'), nodeKey('n3'), linkKey('e2')]);
    expect(stepWalk(walkOrder(state.visibleGraph()), nodeKey('n0'), 1)).toBe(nodeKey('n2'));
    runSelectionCommand(state, 'select-all');
    expect([...state.presentation.view.getState().selection]).toEqual([nodeKey('n0'), nodeKey('n2'), nodeKey('n3')]);
    state.presentation.select([nodeKey('n0')]);
    runSelectionCommand(state, 'invert-selection');
    expect([...state.presentation.view.getState().selection]).toEqual([nodeKey('n2'), nodeKey('n3')]);
  });
});
