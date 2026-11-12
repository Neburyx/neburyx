import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { hideEntities } from '../canvas/hide-commands.js';
import { entity, keyOf } from '../inspector/inspector-kit.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { loadGraph } from './context-menu-kit.js';
import { STARTING_ENTITY_HINT } from './expand-copy.js';
import { isOnlyStartingEntity, StartingEntityHint } from './starting-hint.js';

afterEach(cleanup);

const HINT = 'Select the entity and press E, or right-click it, to load its neighbors';

function draw() {
  const state = createClientState();
  render(
    <ClientStateProvider state={state}>
      <StartingEntityHint />
    </ClientStateProvider>,
  );
  return state;
}

describe('the hint on a canvas that shows only the starting entity', () => {
  it('says how to load the neighbors, in a status region that takes no focus', () => {
    const state = draw();
    act(() => loadGraph(state, [entity('n1')], []));
    const hint = screen.getByRole('status');
    expect(STARTING_ENTITY_HINT).toBe(HINT);
    expect(hint.textContent).toBe(HINT);
    expect(hint.tabIndex).toBe(-1);
    expect(hint.querySelector('button, a, input')).toBeNull();
  });

  it('shows nothing while no entity is loaded', () => {
    const state = draw();
    act(() => loadGraph(state, [], []));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('is gone once an expansion has loaded another entity, and stays gone when that entity is hidden', () => {
    const state = draw();
    act(() => loadGraph(state, [entity('n1')], []));
    expect(screen.getByRole('status')).toBeTruthy();
    act(() => loadGraph(state, [entity('n1'), entity('n2')], []));
    expect(screen.queryByRole('status')).toBeNull();
    act(() => hideEntities(state, [keyOf('n2')]));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('is decided by the loaded graph alone: one entity and no relationship', () => {
    const nodes = [entity('n1'), entity('n2')];
    expect(isOnlyStartingEntity({ nodes: [nodes[0] ?? entity('n1')], edges: [], entities: { value: 1, quality: 'exact', scope: 'x' }, relationships: { value: 0, quality: 'exact', scope: 'x' } })).toBe(true);
    expect(isOnlyStartingEntity({ nodes, edges: [], entities: { value: 2, quality: 'exact', scope: 'x' }, relationships: { value: 0, quality: 'exact', scope: 'x' } })).toBe(false);
    expect(isOnlyStartingEntity({ nodes: [], edges: [], entities: { value: 0, quality: 'exact', scope: 'x' }, relationships: { value: 0, quality: 'exact', scope: 'x' } })).toBe(false);
  });
});
