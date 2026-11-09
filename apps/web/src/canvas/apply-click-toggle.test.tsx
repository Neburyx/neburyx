import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { edge, key, node, ref } from '../state/test-data.js';
import { createSelectionActionRegistry, SelectionActionsProvider } from '../workspace/selection-actions.js';
import { SelectionBar } from '../workspace/selection-bar.js';
import { applyClick } from './apply-click.js';

const a = ref('a', 'type-a', 'n1');
const b = ref('a', 'type-a', 'n2');
const stored = edge('a', 'e1', 'n1', 'n2');

function loaded(): ClientState {
  const state = createClientState();
  state.bindSource('a');
  state.putResult(key('a'), { sourceId: 'a', nodes: [node('a', 'n1'), node('a', 'n2')], edges: [stored] });
  state.setLoaded([key('a')], [a, b], [stored.ref]);
  return state;
}

describe('a click with the toggle modifier applied to the state', () => {
  it('builds a selection of a relationship and an entity, shown by the selection bar as 2 selected, and removes one on a second click', () => {
    const state = loaded();
    render(
      <ClientStateProvider state={state}>
        <SelectionActionsProvider registry={createSelectionActionRegistry()}>
          <SelectionBar />
        </SelectionActionsProvider>
      </ClientStateProvider>,
    );
    act(() => applyClick(state, { target: edgeKey(stored.ref), shift: false, toggle: true }));
    act(() => applyClick(state, { target: elementKey(a), shift: false, toggle: true }));
    expect([...state.presentation.view.getState().selection]).toEqual([edgeKey(stored.ref), elementKey(a)]);
    expect(screen.getByText('2 selected')).not.toBeNull();
    act(() => applyClick(state, { target: edgeKey(stored.ref), shift: false, toggle: true }));
    expect([...state.presentation.view.getState().selection]).toEqual([elementKey(a)]);
  });

  it('leaves the selection as it is in the mode pan', () => {
    const state = loaded();
    act(() => state.presentation.select([elementKey(a)]));
    act(() => state.presentation.setTool('pan'));
    act(() => applyClick(state, { target: elementKey(b), shift: false, toggle: true }));
    expect([...state.presentation.view.getState().selection]).toEqual([elementKey(a)]);
  });
});
