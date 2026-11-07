import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ExpandRequest, ExpandResponse } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiResult } from '../api/client.js';
import { createExpandStore } from '../api/expand-store.js';
import { fakeClient } from '../api/fake-client.js';
import { testProfile } from '../dev/test-profile.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { edge, node, ref } from '../state/test-data.js';
import { ExpandByTypeSubmenu } from './expand-by-type-submenu.js';
import { ExpandProvider, expansionControlsOf } from './expand-context.js';
import { ExpandSelectionAction } from './expand-selection-action.js';
import { registerBuiltInKeyBindings } from './built-in-key-bindings.js';
import { createKeyListener } from './key-binding-handler.js';
import { createKeyBindingRegistry } from './key-binding-registry.js';
import { menuHeader } from './menu-header.js';
import { createSelectionActionRegistry, SelectionActionsProvider } from './selection-actions.js';
import { SelectionBar } from './selection-bar.js';
import { loadGraph, nodeKey } from './context-menu-kit.js';
import { ProfileProvider } from '../canvas/profile-context.js';
import { staticProfile } from '../test-utils.js';
import { PreviewProvider } from './preview-context.js';
import { createPreviewStore } from '../api/preview-store.js';

afterEach(() => cleanup());

interface Ask {
  readonly body: ExpandRequest;
  readonly answer: (result: ApiResult<ExpandResponse>) => void;
}

const profile = testProfile('a', ['type-a', 'type-b']);

function rig() {
  const asked: Ask[] = [];
  const client = fakeClient({ expandNeighbors: (body) => new Promise((resolve) => void asked.push({ body, answer: resolve })) });
  const state = createClientState();
  loadGraph(state, [node('a', 'n1'), node('a', 'n2'), node('a', 'n3')], [edge('a', 'e1', 'n1', 'n2')]);
  const store = createExpandStore(client, state, () => 'person-1');
  return { asked, state, store, controls: expansionControlsOf(store, profile) };
}

const press = (listener: (event: KeyboardEvent) => void, key: string) => listener(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

describe('the E key', () => {
  function keyed() {
    const parts = rig();
    const registry = createKeyBindingRegistry('mac');
    registerBuiltInKeyBindings(registry);
    const listener = createKeyListener(registry, () => ({ state: parts.state, canvas: undefined, expansion: parts.controls }));
    return { ...parts, listener };
  }

  it('expands the one selected node with one request for every mapped neighbor type', () => {
    const { asked, state, listener } = keyed();
    state.presentation.select([nodeKey('n1')]);
    press(listener, 'e');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.body).toMatchObject({ ref: { entityType: 'type-a', stableId: 'n1' }, neighborTypes: ['type-b'], direction: 'both' });
  });

  it('does nothing with several items selected, with a relationship selected, with nothing selected, or with a menu open', () => {
    const { asked, state, listener } = keyed();
    state.presentation.select([nodeKey('n1'), nodeKey('n2')]);
    press(listener, 'e');
    state.presentation.select([edgeKey(edge('a', 'e1', 'n1', 'n2').ref)]);
    press(listener, 'e');
    state.presentation.select([]);
    press(listener, 'e');
    state.presentation.select([nodeKey('n1')]);
    state.presentation.setOpenMenu({ kind: 'node', key: nodeKey('n1'), x: 1, y: 1 });
    press(listener, 'e');
    expect(asked).toHaveLength(0);
  });
});

describe('Expand on the selection bar', () => {
  function barred() {
    const parts = rig();
    const registry = createSelectionActionRegistry();
    render(
      <ClientStateProvider state={parts.state}>
        <SelectionActionsProvider registry={registry}>
          <ProfileProvider store={staticProfile('a', profile)}>
            <ExpandProvider store={parts.store}>
              <ExpandSelectionAction />
              <SelectionBar />
            </ExpandProvider>
          </ProfileProvider>
        </SelectionActionsProvider>
      </ClientStateProvider>,
    );
    return parts;
  }

  it('expands each selected node by a request of its own, one after another, and skips the relationships', async () => {
    const { asked, state } = barred();
    act(() => state.presentation.select([nodeKey('n1'), nodeKey('n2'), edgeKey(edge('a', 'e1', 'n1', 'n2').ref)]));
    await userEvent.setup().click(within(screen.getByRole('toolbar', { name: 'Selection actions' })).getByRole('button', { name: 'Expand' }));
    expect(asked.map((ask) => ask.body.ref.stableId)).toEqual(['n1']);
    await act(async () => asked[0]?.answer({ ok: false, failure: { code: 'QUERY_TIMEOUT', message: 'x', retryable: true, traceId: 'tr-1' } }));
    expect(asked.map((ask) => ask.body.ref.stableId)).toEqual(['n1', 'n2']);
    expect(asked.every((ask) => ask.body.neighborTypes.length === 1)).toBe(true);
  });
});

describe('what the submenu says when it cannot offer a count or a type', () => {
  function submenuFor(key: string | undefined, options: { readonly answer?: boolean } = {}) {
    const { store, state } = rig();
    const asked: { body: unknown; answer: (result: ApiResult<never>) => void }[] = [];
    const previews = createPreviewStore(
      fakeClient({ previewExpansion: (body) => new Promise((resolve) => void asked.push({ body, answer: resolve as never })) }),
      () => 'person-1',
    );
    render(
      <ClientStateProvider state={state}>
        <PreviewProvider store={previews}>
          <ProfileProvider store={staticProfile('a', profile)}>
            <ExpandProvider store={store}>
              <ExpandByTypeSubmenu context={{ kind: 'node', key, selection: [], state, canvas: undefined }} close={() => undefined} />
            </ExpandProvider>
          </ProfileProvider>
        </PreviewProvider>
      </ClientStateProvider>,
    );
    return { asked, options };
  }

  it('says the node cannot be expanded when it has no stable ID, and asks for nothing', () => {
    const { asked } = submenuFor(undefined);
    expect(screen.getByText('This item cannot be expanded: no stable ID.')).not.toBeNull();
    expect(asked).toHaveLength(0);
  });

  it('keeps the mapped neighbor types tickable, without counts, while the preview is loading and after it failed, and tells a failed preview from "no relationships"', async () => {
    const { asked } = submenuFor(nodeKey('n1'));
    const boxes = () => screen.getAllByRole('checkbox').map((row) => row.textContent);
    expect(boxes()).toEqual(['TYPE-B']);
    expect(screen.getByRole('status').textContent).toBe('Loading neighbors');
    await act(async () => asked[0]?.answer({ ok: false, failure: { code: 'SOURCE_UNAVAILABLE', message: 'x', retryable: true, traceId: 'tr-3' } } as never));
    expect(boxes()).toEqual(['TYPE-B']);
    expect(screen.getByRole('alert').textContent).toBe('SOURCE_UNAVAILABLE · trace tr-3');
    expect(screen.queryByText('No relationships are mapped for this entity type.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Expand 1 neighbor' })).not.toBeNull();
  });
});

describe('the header of the menu of an aggregate relationship', () => {
  it('names the first and last observed time beside the member count', () => {
    const base = edge('a', 'e1', 'n1', 'n2');
    const aggregate = {
      ...base,
      ref: { sourceId: 'a', aggregate: { type: 'rel-a', from: ref('a', 'type-a', 'n1'), to: ref('a', 'type-a', 'n2') } },
      memberCount: { value: 3, quality: 'exact' as const, scope: 'members' },
      observedFirst: '2026-04-01T00:00:00Z',
      observedLast: '2026-04-02T00:00:00Z',
    };
    const state = createClientState();
    state.bindSource('a');
    const graph = { nodes: [node('a', 'n1'), node('a', 'n2')], edges: [aggregate], hidden: new Set<string>() } as never;
    const header = menuHeader({ kind: 'relationship', key: edgeKey(aggregate.ref), x: 0, y: 0 }, graph, undefined);
    expect(header?.title).toBe('rel-a · 3 · exact · sourced');
    expect(header?.detail).toBe('n1 ↔ n2 · first 2026-04-01T00:00:00Z · last 2026-04-02T00:00:00Z');
    expect(elementKey(ref('a', 'type-a', 'n1'))).toBeDefined();
  });
});
