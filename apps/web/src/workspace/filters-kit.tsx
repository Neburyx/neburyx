import { act, fireEvent, screen } from '@testing-library/react';
import type { GraphNode } from '@neburyx/contracts';
import { fakeClient } from '../api/fake-client.js';
import type { ApiClient } from '../api/client.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { node, ref } from '../state/test-data.js';
import { me, renderApp, source, stubFactory } from '../test-utils.js';
import { profiled } from '../search/search-test-kit.js';
import { registerSearchTool } from '../search/search-tool.js';
import { registerBuiltInSlots } from './built-in-slots.js';
import { registerBuiltInTools } from './built-in-tools.js';
import { loadGraph } from './context-menu-kit.js';
import { registerFiltersTool } from './filters-tool.js';
import { createPanelRegistryFor } from './panel-registry.js';
import { createSlotRegistry } from './slots.js';
import { createToolRegistry } from './tool-registry.js';

export const typedNode = (id: string, entityType: string): GraphNode => ({ ...node('a', id), ref: ref('a', entityType, id), display: { title: id, type: entityType } });

export interface FiltersWorkspace {
  readonly state: ClientState;
  readonly client: ApiClient;
  readonly unmount: () => void;
}

/** The workspace with the Filters tool registered over a graph of entities of three types of the mapping; the panel is closed. */
export async function filtersWorkspace(nodes: readonly GraphNode[] = [typedNode('n0', 'kind-a'), typedNode('n1', 'kind-a'), typedNode('n2', 'kind-b'), typedNode('n3', 'kind-c')], types: readonly string[] | 'pending' = ['kind-a', 'kind-b', 'kind-c']): Promise<FiltersWorkspace> {
  const client = fakeClient({
    getProfile: types === 'pending' ? () => new Promise(() => undefined) : async (sourceId) => ({ ok: true, value: profiled(sourceId, types) }),
    getMe: async () => ({ ok: true, value: me() }),
    getSources: async () => ({ ok: true, value: { items: [source('a')], nextCursor: null } }),
  });
  const state = createClientState();
  loadGraph(state, nodes, []);
  const slots = createSlotRegistry();
  registerBuiltInSlots(slots);
  const tools = createToolRegistry();
  registerBuiltInTools(tools);
  registerFiltersTool(tools, state);
  registerSearchTool(tools, state);
  const view = renderApp('/explore', client, state, slots, stubFactory().create, undefined, tools, undefined, createPanelRegistryFor(state));
  await act(async () => void (await Promise.resolve()));
  await act(async () => void (await Promise.resolve()));
  return { state, client, unmount: view.unmount };
}

export const openFilters = (): void => void fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
