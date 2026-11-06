import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GraphCanvas } from '../canvas/graph-canvas.js';
import { RendererProvider } from '../canvas/renderer-context.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { elementKey } from '../state/keys.js';
import { stubFactory } from '../test-utils.js';
import { openedKey } from './open-flow.js';
import { INVESTIGATION_A, nodeOf } from './test-data.js';

const first = nodeOf('source-a', 'kind-a', 'A-1');
const second = nodeOf('source-a', 'kind-a', 'A-2');

function openedWithOneEntity() {
  const state = createClientState();
  const key = openedKey('source-a', 'principal-1', INVESTIGATION_A, false);
  state.show(
    { id: INVESTIGATION_A, sourceId: 'source-a', record: { title: 'kind-a A-1', caseRef: null, save: { kind: 'unsaved' } }, resultKeys: [key], nodeRefs: [first.ref], edgeRefs: [] },
    [{ key, result: { sourceId: 'source-a', nodes: [first], edges: [] } }],
  );
  return state;
}

describe('adding an entity to an investigation that was opened from one entity', () => {
  it('places only the added entity, and leaves the position of the first where the layout and the person put it', () => {
    const state = openedWithOneEntity();
    const factory = stubFactory();
    render(
      <ClientStateProvider state={state}>
        <RendererProvider createRenderer={factory.create}>
          <GraphCanvas profile={undefined} />
        </RendererProvider>
      </ClientStateProvider>,
    );
    const one = elementKey(first.ref);
    const two = elementKey(second.ref);
    expect([...state.presentation.view.getState().positions.keys()]).toEqual([one]);
    act(() => state.presentation.setPosition(one, { x: 1234, y: -56 }));

    const shown = state.investigation.getState();
    const addKey = { ...openedKey('source-a', 'principal-1', INVESTIGATION_A, false), params: 'added:A-2' };
    act(() => {
      state.putResult(addKey, { sourceId: 'source-a', nodes: [second], edges: [] });
      state.setLoaded([...shown.resultKeys, addKey], [...shown.nodeRefs, second.ref], []);
    });

    const positions = state.presentation.view.getState().positions;
    expect([...positions.keys()].sort()).toEqual([one, two].sort());
    expect(positions.get(one)).toEqual({ x: 1234, y: -56 });
    expect(positions.get(two)).toBeDefined();
    expect(positions.get(two)).not.toEqual(positions.get(one));
    const scene = factory.made[0]?.scenes.at(-1);
    expect(scene?.entities.map((entity) => entity.id).sort()).toEqual([one, two].sort());
    expect(scene?.entities.find((entity) => entity.id === one)?.position).toEqual({ x: 1234, y: -56 });
  });
});
