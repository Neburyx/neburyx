import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ExpandRequest, ExpandResponse } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiResult } from '../api/client.js';
import { createExpandStore } from '../api/expand-store.js';
import { fakeClient } from '../api/fake-client.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { node, ref } from '../state/test-data.js';
import { ExpandProvider, expansionControlsOf } from './expand-context.js';
import { createSelectionActionRegistry, SelectionActionsProvider } from './selection-actions.js';
import { ExpandSelectionAction } from './expand-selection-action.js';
import { ExpansionStatus } from './expansion-status.js';
import { loadGraph, nodeKey } from './context-menu-kit.js';

afterEach(() => cleanup());

function rig() {
  const asked: { body: ExpandRequest; answer: (result: ApiResult<ExpandResponse>) => void }[] = [];
  const state = createClientState();
  loadGraph(state, [node('a', 'n1'), node('a', 'n2')], []);
  const store = createExpandStore(fakeClient({ expandNeighbors: (body) => new Promise((resolve) => void asked.push({ body, answer: resolve })) }), state, () => 'person-1');
  render(
    <ClientStateProvider state={state}>
      <ExpandProvider store={store}>
        <ExpansionStatus />
      </ExpandProvider>
    </ClientStateProvider>,
  );
  return { asked, state, store };
}

describe('what shows of an expansion started outside the submenu', () => {
  it('says how many are running, then names a failure with Retry for its node, and asks again on Retry', async () => {
    const { asked, store } = rig();
    expect(screen.queryByRole('status')).toBeNull();
    act(() => void store.expand(ref('a', 'type-a', 'n1'), ['type-b']));
    expect(screen.getByRole('status').textContent).toBe('Expanding 1 item');
    await act(async () => asked[0]?.answer({ ok: false, failure: { code: 'QUERY_TIMEOUT', message: 'x', retryable: true, traceId: 'tr-1' } }));
    expect(screen.getByText('n1')).not.toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('QUERY_TIMEOUT · trace tr-1');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(asked).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toBe('Expanding 1 item');
  });

  it('offers no Retry for an unavailable source that retrying cannot help, and offers it when it can', async () => {
    const { asked, store } = rig();
    act(() => void store.expand(ref('a', 'type-a', 'n1'), ['type-b']));
    await act(async () => asked[0]?.answer({ ok: false, failure: { code: 'SOURCE_UNAVAILABLE', message: 'x', retryable: false, traceId: 'tr-3', details: { reason: 'index-unavailable' } } }));
    expect(screen.getByRole('alert')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    act(() => void store.expand(ref('a', 'type-a', 'n2'), ['type-b']));
    await act(async () => asked[1]?.answer({ ok: false, failure: { code: 'SOURCE_UNAVAILABLE', message: 'x', retryable: true, traceId: 'tr-4', details: { reason: 'index-building' } } }));
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
  });

  it('says so when the item has no mapped neighbor types, and clears it when another expansion is asked', () => {
    const { store, state } = rig();
    const controls = expansionControlsOf(store, undefined);
    act(() => void controls.expandNode(nodeKey('n1')));
    expect(screen.getByRole('status').textContent).toBe('This item has no mapped neighbor types to expand.');
    act(() => void store.expand(ref('a', 'type-a', 'n2'), ['type-b']));
    expect(screen.queryByText('This item has no mapped neighbor types to expand.')).toBeNull();
    expect(state.loadedGraph().nodes).toHaveLength(2);
  });

  it('keeps the failure of the first node on show while the second node is expanded', async () => {
    const { asked, store } = rig();
    act(() => void store.expand(ref('a', 'type-a', 'n1'), ['type-b']));
    await act(async () => asked[0]?.answer({ ok: false, failure: { code: 'SOURCE_BUSY', message: 'x', retryable: true, traceId: 'tr-2' } }));
    act(() => void store.expand(ref('a', 'type-a', 'n2'), ['type-b']));
    expect(within(screen.getByRole('alert')).getByText('SOURCE_BUSY · trace tr-2')).not.toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Expanding 1 item');
  });

  const NO_ID = '["node","a","type-a",""]';

  it('says an item with no stable ID cannot be expanded, from the command and the E key, and sends nothing', () => {
    const { asked, store } = rig();
    const controls = expansionControlsOf(store, undefined);
    act(() => void controls.expandNode(NO_ID));
    expect(screen.getByRole('status').textContent).toBe('1 item cannot be expanded: no stable ID.');
    expect(asked).toHaveLength(0);
  });

  it('says so on the selection bar for the items with no stable ID, and sends no request for them', () => {
    const asked: ExpandRequest[] = [];
    const state = createClientState();
    loadGraph(state, [node('a', 'n1')], []);
    const store = createExpandStore(fakeClient({ expandNeighbors: (body) => new Promise(() => void asked.push(body)) }), state, () => 'person-1');
    const registry = createSelectionActionRegistry();
    render(
      <ClientStateProvider state={state}>
        <SelectionActionsProvider registry={registry}>
          <ExpandProvider store={store}>
            <ExpandSelectionAction />
          </ExpandProvider>
        </SelectionActionsProvider>
      </ClientStateProvider>,
    );
    const action = registry.view.getState().find((entry) => entry.id === 'expand');
    const note = action?.run([NO_ID, nodeKey('n1')]);
    expect(note).toBe('1 item cannot be expanded: no stable ID.');
    expect(asked).toHaveLength(0);
  });
});
