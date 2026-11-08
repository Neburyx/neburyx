import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ExpandResponse } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createExpandStore } from '../api/expand-store.js';
import { fakeClient } from '../api/fake-client.js';
import type { RightClick } from '../canvas/scene.js';
import { createClientState } from '../state/client-state.js';
import { edgeRef, node, ref } from '../state/test-data.js';
import { loadGraph, nodeKey, show } from './context-menu-kit.js';
import { ExpandProvider } from './expand-context.js';
import { MENU_GROUP, MENU_ORDER, createMenuRegistry } from './menu-registry.js';
import { registerBuiltInMenuItems } from './built-in-menu-items.js';

afterEach(() => cleanup());

const nodeOf = (type: string, id: string) => ({ ...node('a', id), ref: ref('a', type, id), display: { title: id, type } });
const answer: ExpandResponse = {
  ref: { sourceId: 'a', entityType: 'type-a', stableId: 'n1' },
  pageSize: 25,
  nodes: [nodeOf('type-a', 'n1'), nodeOf('kind-b', 'b1')],
  edges: [{ ref: edgeRef('a', 'r1', 'link-a', 'type-a', 'kind-b'), from: ref('a', 'type-a', 'n1'), to: ref('a', 'kind-b', 'b1'), type: 'link-a', direction: 'out', semantics: 'stored', properties: [], evidenceRefs: [], qualityFlags: [] }],
  pages: [{ neighborType: 'kind-b', returned: 1, hasMore: false, matchingTotal: { value: 1, quality: 'exact', scope: 'x' } }],
  warnings: [],
};

function opened() {
  const requests: unknown[] = [];
  const client = fakeClient({
    expandNeighbors: (body) => {
      requests.push(body);
      return Promise.resolve({ ok: true as const, value: answer });
    },
  });
  const state = createClientState();
  loadGraph(state, [node('a', 'n1')], []);
  const expand = createExpandStore(client, state, () => 'person-1');
  const view = show(state, {}, undefined, null, (tree) => <ExpandProvider store={expand}>{tree}</ExpandProvider>);
  const open = (): void => view.rightClick({ target: { kind: 'node', key: nodeKey('n1') }, x: 50, y: 60 } satisfies RightClick);
  return { state, expand, requests, open };
}

const isOff = (element: HTMLElement): boolean => (element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true';
const collapseItem = () => within(screen.getByRole('menu', { name: 'n1' })).getByRole('menuitem', { name: 'Collapse' });

describe('the Collapse item of the node menu', () => {
  it('sits in the Expand group after Expand by type', () => {
    const registry = createMenuRegistry();
    registerBuiltInMenuItems(registry);
    const collapse = (registry.view.getState().get('node') ?? []).find((entry) => entry.id === 'collapse');
    expect(collapse).toMatchObject({ group: MENU_GROUP.node.expand, order: MENU_ORDER.node.collapse });
    expect(MENU_ORDER.node.collapse).toBeGreaterThan(MENU_ORDER.node.expandByType);
  });

  it('is off for a node nothing was loaded from, and takes back its expansion when chosen, with no request', async () => {
    const { state, expand, requests, open } = opened();
    open();
    expect(isOff(collapseItem())).toBe(true);
    await act(async () => void (await expand.expand(ref('a', 'type-a', 'n1'), ['kind-b'])));
    expect(state.loadedGraph().nodes).toHaveLength(2);
    await userEvent.keyboard('{Escape}');
    open();
    expect(isOff(collapseItem())).toBe(false);
    await userEvent.click(collapseItem());
    expect(state.loadedGraph().nodes.map((held) => held.ref.stableId)).toEqual(['n1']);
    expect(requests).toHaveLength(1);
  });

  it('is off while an ask for the node is running and on again after the answer', async () => {
    const release: { go?: () => void } = {};
    const client = fakeClient({ expandNeighbors: () => new Promise((resolve) => void (release.go = () => resolve({ ok: true as const, value: answer }))) });
    const state = createClientState();
    loadGraph(state, [node('a', 'n1')], []);
    const expand = createExpandStore(client, state, () => 'person-1');
    const view = show(state, {}, undefined, null, (tree) => <ExpandProvider store={expand}>{tree}</ExpandProvider>);
    const open = (): void => view.rightClick({ target: { kind: 'node', key: nodeKey('n1') }, x: 50, y: 60 } satisfies RightClick);
    const running = expand.expand(ref('a', 'type-a', 'n1'), ['kind-b']);
    open();
    expect(isOff(collapseItem())).toBe(true);
    await userEvent.keyboard('{Escape}');
    await act(async () => {
      release.go?.();
      await running;
    });
    open();
    expect(isOff(collapseItem())).toBe(false);
  });
});
