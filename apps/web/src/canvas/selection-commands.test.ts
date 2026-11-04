import { describe, expect, it } from 'vitest';
import { createClientState, type ClientState } from '../state/client-state.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { edgeRef, key, ref, result } from '../state/test-data.js';
import { runSelectionCommand, SELECTION_COMMAND_IDS } from './selection-commands.js';

const node = (id: string) => elementKey(ref('a', 'type-a', id));
const edge = (id: string) => edgeKey(edgeRef('a', id));

function loaded(nodes: readonly string[], edges: ReadonlyArray<readonly [string, string, string]> = [], loadedNodes: readonly string[] = nodes): ClientState {
  const state = createClientState();
  state.bindSource('a');
  state.putResult(key('a'), result('a', [...nodes], edges.map(([id, from, to]) => [id, from, to] as [string, string, string])));
  state.setLoaded([key('a')], loadedNodes.map((id) => ref('a', 'type-a', id)), edges.map(([id]) => edgeRef('a', id)));
  return state;
}

const selected = (state: ClientState): string[] => [...state.presentation.view.getState().selection];

describe('the selection commands', () => {
  it('are defined once, under the ids the tool strip, the keys and the canvas menu use', () => {
    expect([...SELECTION_COMMAND_IDS]).toEqual(['select-all', 'invert-selection', 'clear-selection']);
  });

  it('select all selects every drawn entity and no relationship, and does nothing, without an error, when nothing is drawn', () => {
    const state = loaded(['n1', 'n2', 'n3'], [['e1', 'n1', 'n2']]);
    state.presentation.select([edge('e1')]);
    runSelectionCommand(state, 'select-all');
    expect(selected(state)).toEqual([node('n1'), node('n2'), node('n3')]);
    const empty = createClientState();
    expect(() => runSelectionCommand(empty, 'select-all')).not.toThrow();
    expect(selected(empty)).toEqual([]);
  });

  it('invert selects the entities that were not selected, deselects the ones that were, and drops selected relationships', () => {
    const state = loaded(['n1', 'n2', 'n3'], [['e1', 'n1', 'n2']]);
    state.presentation.select([node('n1'), edge('e1')]);
    runSelectionCommand(state, 'invert-selection');
    expect(selected(state)).toEqual([node('n2'), node('n3')]);
  });

  it('invert twice on a selection of entities gives the selection back', () => {
    const state = loaded(['n1', 'n2', 'n3']);
    state.presentation.select([node('n2')]);
    runSelectionCommand(state, 'invert-selection');
    runSelectionCommand(state, 'invert-selection');
    expect(selected(state)).toEqual([node('n2')]);
  });

  it('clear empties the selection, and leaves the stored state alone when it is already empty', () => {
    const state = loaded(['n1', 'n2']);
    state.presentation.select([node('n1'), node('n2')]);
    runSelectionCommand(state, 'clear-selection');
    expect(selected(state)).toEqual([]);
    const before = state.presentation.view.getState();
    runSelectionCommand(state, 'clear-selection');
    expect(state.presentation.view.getState()).toBe(before);
  });

  it('never put a relationship in the selection when its entity is not loaded and so it is not drawn', () => {
    const state = loaded(['n1', 'n2'], [['e1', 'n1', 'n9']], ['n1', 'n2']);
    runSelectionCommand(state, 'select-all');
    expect(selected(state)).toEqual([node('n1'), node('n2')]);
    state.presentation.select([edge('e1')]);
    runSelectionCommand(state, 'invert-selection');
    expect(selected(state)).toEqual([node('n1'), node('n2')]);
    runSelectionCommand(state, 'clear-selection');
    expect(selected(state)).toEqual([]);
  });
});
