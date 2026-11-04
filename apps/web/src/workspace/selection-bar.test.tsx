import type { EdgeRef, GraphEdge } from '@neburyx/contracts';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { edge, key, node, ref } from '../state/test-data.js';
import { CLIPBOARD_UNAVAILABLE } from './clipboard.js';
import { createSelectionActionRegistry, SelectionActionsProvider, type SelectionAction, type SelectionActionRegistry } from './selection-actions.js';
import { SelectionBar } from './selection-bar.js';

const a = ref('a', 'type-a', 'n1');
const b = ref('a', 'type-a', 'n2');
const c = ref('a', 'type-a', 'n3');
const withRef = (id: string, edgeRef: EdgeRef): GraphEdge => ({ ...edge('a', id, 'n1', 'n2'), ref: edgeRef });
const stored = edge('a', 'e1', 'n1', 'n2');
const unknownOrigin: GraphEdge = { ...withRef('e2', { sourceId: 'a', stableId: 'e2' }), semantics: 'unknown' };
const aggregate = withRef('g', { sourceId: 'a', aggregate: { type: 'rel-a', from: a, to: b } });
const derived: GraphEdge = { ...withRef('d', { sourceId: 'a', derived: { ruleId: 'rule-1', from: a, to: b } }), semantics: 'derived' };
const dangling = edge('a', 'e9', 'n1', 'n9');

function loaded(): ClientState {
  const state = createClientState();
  const edges = [stored, unknownOrigin, aggregate, derived, dangling];
  state.bindSource('a');
  state.putResult(key('a'), { sourceId: 'a', nodes: [node('a', 'n1'), node('a', 'n2'), node('a', 'n3')], edges });
  state.setLoaded([key('a')], [a, b, c], edges.map((item) => item.ref));
  return state;
}

function show(state: ClientState, registry: SelectionActionRegistry = createSelectionActionRegistry()) {
  return render(
    <ClientStateProvider state={state}>
      <SelectionActionsProvider registry={registry}>
        <SelectionBar />
      </SelectionActionsProvider>
    </ClientStateProvider>,
  );
}

const select = (state: ClientState, ...keys: string[]): void => act(() => state.presentation.select(keys));
const node1 = elementKey(a);
const node2 = elementKey(b);
const node3 = elementKey(c);
const button = (name: string) => screen.getByRole('button', { name });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the selection action bar', () => {
  it('is absent with nothing or one item selected and appears at two, named as a toolbar, with the count, Copy IDs and Clear selection', () => {
    const state = loaded();
    show(state);
    expect(screen.queryByRole('toolbar')).toBeNull();
    select(state, node1);
    expect(screen.queryByRole('toolbar')).toBeNull();
    select(state, node1, node2);
    expect(screen.getByRole('toolbar', { name: 'Selection actions' })).not.toBeNull();
    expect(screen.getByText('2 selected')).not.toBeNull();
    expect(button('Copy IDs')).not.toBeNull();
    expect(button('Clear selection')).not.toBeNull();
    select(state, node1, node2, node3);
    expect(screen.getByText('3 selected')).not.toBeNull();
  });

  it('does not count a selected relationship that is loaded but not drawn', () => {
    const state = loaded();
    show(state);
    select(state, node1, edgeKey(dangling.ref));
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('shows registered actions before Copy IDs in registration order, runs one with the selected keys, and drops it when it is taken out', async () => {
    const state = loaded();
    const registry = createSelectionActionRegistry();
    const ran: Array<readonly string[]> = [];
    const expand: SelectionAction = { id: 'expand', label: 'Expand', icon: <span aria-hidden="true">+</span>, run: (selection) => void ran.push(selection) };
    const hide: SelectionAction = { id: 'hide', label: 'Hide', icon: null, run: () => undefined };
    const removeExpand = registry.register(expand);
    registry.register(hide);
    show(state, registry);
    select(state, node1, node2);
    expect(screen.getAllByRole('button').map((item) => item.textContent)).toEqual(['+Expand', 'Hide', 'Copy IDs', '']);
    await userEvent.setup().click(button('Expand'));
    expect(ran).toEqual([[node1, node2]]);
    act(() => removeExpand());
    expect(screen.queryByRole('button', { name: 'Expand' })).toBeNull();
    expect(button('Hide')).not.toBeNull();
  });

  it('clears the selection with Clear selection and goes away', async () => {
    const state = loaded();
    show(state);
    select(state, node1, node2);
    await userEvent.setup().click(button('Clear selection'));
    expect(state.presentation.view.getState().selection.size).toBe(0);
    expect(screen.queryByRole('toolbar')).toBeNull();
  });
});

describe('Copy IDs in the selection action bar', () => {
  it('writes the stable IDs of the selected entities, one per line in selection order, and says how many', async () => {
    const state = loaded();
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText');
    show(state);
    select(state, node2, node1, node3);
    await user.click(button('Copy IDs'));
    expect(write).toHaveBeenCalledWith('n2\nn1\nn3');
    expect(screen.getByRole('status').textContent).toBe('Copied 3 IDs');
  });

  it('copies a stored relationship of unknown origin, skips an aggregate and a derived one, and says how many had no ID', async () => {
    const state = loaded();
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText');
    show(state);
    select(state, node1, edgeKey(unknownOrigin.ref), edgeKey(aggregate.ref), edgeKey(derived.ref));
    await user.click(button('Copy IDs'));
    expect(write).toHaveBeenCalledWith('n1\ne2');
    expect(screen.getByRole('status').textContent).toBe('Copied 2 IDs (2 selected items have no ID)');
  });

  it('writes nothing and says so when no selected item has an ID', async () => {
    const state = loaded();
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText');
    show(state);
    select(state, edgeKey(aggregate.ref), edgeKey(derived.ref));
    await user.click(button('Copy IDs'));
    expect(write).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('No IDs to copy');
  });

  it('shows CLIPBOARD_UNAVAILABLE as an alert when the write is refused, and keeps the selection and the bar', async () => {
    const state = loaded();
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    show(state);
    select(state, node1, node2);
    await user.click(button('Copy IDs'));
    expect(screen.getByRole('alert').textContent).toBe(CLIPBOARD_UNAVAILABLE);
    expect(state.presentation.view.getState().selection.size).toBe(2);
    expect(screen.getByRole('toolbar')).not.toBeNull();
  });

  it('shows CLIPBOARD_UNAVAILABLE when the browser has no clipboard', async () => {
    const state = loaded();
    const user = userEvent.setup();
    show(state);
    select(state, node1, node2);
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    await user.click(button('Copy IDs'));
    expect(screen.getByRole('alert').textContent).toBe(CLIPBOARD_UNAVAILABLE);
  });

  it('shows the result of the latest request when an earlier one finishes after it', async () => {
    const state = loaded();
    const user = userEvent.setup();
    const pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(() => new Promise<void>((resolve, reject) => void pending.push({ resolve, reject })));
    show(state);
    select(state, node1, node2);
    await user.click(button('Copy IDs'));
    await user.click(button('Copy IDs'));
    expect(pending).toHaveLength(2);
    await act(async () => pending[1]?.resolve());
    expect(screen.getByRole('status').textContent).toBe('Copied 2 IDs');
    await act(async () => pending[0]?.reject(new Error('denied')));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Copied 2 IDs');
  });

  it('forgets its status when the selection changes', async () => {
    const state = loaded();
    const user = userEvent.setup();
    show(state);
    select(state, node1, node2);
    await user.click(button('Copy IDs'));
    expect(screen.queryByRole('status')).not.toBeNull();
    select(state, node1, node3);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('the keyboard in the selection action bar', () => {
  it('reaches the buttons in order with Tab, and acts on Enter and Space', async () => {
    const state = loaded();
    const registry = createSelectionActionRegistry();
    const ran: string[] = [];
    registry.register({ id: 'expand', label: 'Expand', icon: null, run: () => void ran.push('expand') });
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText');
    show(state, registry);
    select(state, node1, node2);
    await user.tab();
    expect(document.activeElement).toBe(button('Expand'));
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    await user.tab();
    expect(document.activeElement).toBe(button('Copy IDs'));
    await user.keyboard('{Enter}');
    await user.tab();
    expect(document.activeElement).toBe(button('Clear selection'));
    await user.keyboard(' ');
    expect(ran).toEqual(['expand', 'expand']);
    expect(write).toHaveBeenCalledOnce();
    expect(state.presentation.view.getState().selection.size).toBe(0);
  });
});
