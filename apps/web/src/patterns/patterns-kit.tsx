import { act, fireEvent, screen } from '@testing-library/react';
import { paramsJsonSchemaOf, type GraphEdge, type GraphNode, type TemplateListResponse, type TemplateRunRequest, type TemplateRunResponse } from '@neburyx/contracts';
import { fakeClient } from '../api/fake-client.js';
import type { ApiClient, ApiFailure, ApiResult } from '../api/client.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { edge as edgeOf, ref } from '../state/test-data.js';
import { createBuiltInBannerController } from '../banner/built-in-causes.js';
import type { BannerController } from '../banner/banner-controller.js';
import { me, renderApp, source, stubFactory } from '../test-utils.js';
import { profiled } from '../search/search-test-kit.js';
import { searchOf } from './search-kit.js';
import { registerSearchTool } from '../search/search-tool.js';
import { registerBuiltInSlots } from '../workspace/built-in-slots.js';
import { registerBuiltInTools } from '../workspace/built-in-tools.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import { registerFiltersTool } from '../workspace/filters-tool.js';
import { typedNode } from '../workspace/filters-kit.js';
import { createPanelRegistryFor } from '../workspace/panel-registry.js';
import { createSlotRegistry } from '../workspace/slots.js';
import { createToolRegistry } from '../workspace/tool-registry.js';
import { registerPatternsTool } from './patterns-tool.js';

type Preset = TemplateListResponse['presets'][number];

export const SHARED_DEVICES: Preset = { id: 'shared-devices', name: 'Shared devices', template: 'shared-attribute', bind: { anchor: 'kind-a', attribute: 'kind-b', via: 'USES' }, labels: [{ key: 'anchor', text: 'Starting account' }, { key: 'limit', text: 'Max matching accounts' }] };
export const SHARED_ADDRESSES: Preset = { id: 'shared-addresses', name: 'Shared addresses', template: 'shared-attribute', bind: { anchor: 'kind-a', attribute: 'kind-c', via: 'FROM' }, labels: [{ key: 'anchor', text: 'Starting account' }] };
export const CONNECTED: Preset = { id: 'connected-accounts', name: 'Connected accounts', template: 'linked-entities', bind: { anchor: 'kind-a', target: 'kind-a', via: 'PAYS' }, labels: [{ key: 'anchor', text: 'Starting account' }, { key: 'maxHops', text: 'Hops' }] };
export const PRESETS: readonly Preset[] = [SHARED_DEVICES, SHARED_ADDRESSES, CONNECTED];

export function listOf(presets: readonly Preset[] = PRESETS): TemplateListResponse {
  return {
    sourceId: 'a',
    templates: (['shared-attribute', 'linked-entities'] as const).map((id) => ({ id, version: '1', name: id, description: id, paramsSchema: paramsJsonSchemaOf(id) })),
    presets: [...presets],
  };
}

export const okRun = (matches: readonly string[], overrides: Partial<Extract<TemplateRunResponse, { status: 'ok' }>> = {}): TemplateRunResponse => {
  const attribute: GraphNode = { ...typedNode('dev-1', 'kind-b') };
  const nodes = [typedNode('acc-1', 'kind-a'), attribute, ...matches.map((id) => typedNode(id, 'kind-a'))];
  const edges: GraphEdge[] = matches.map((id, index) => ({ ...edgeOf('a', `e${index}`, id, 'dev-1'), from: ref('a', 'kind-a', id), to: ref('a', 'kind-b', 'dev-1'), evidenceRefs: [`AUTH-${index}`] }));
  return { status: 'ok', templateId: 'shared-attribute', templateVersion: '1', presetId: 'shared-devices', count: { value: matches.length, quality: 'exact', scope: 'matches' }, matchIds: matches.map((id) => ref('a', 'kind-a', id)), nodes, edges, notices: [], warnings: [], ...overrides };
};

export const heavyRun = (): TemplateRunResponse => ({ status: 'heavy', templateId: 'shared-attribute', templateVersion: '1', presetId: 'shared-devices', estimate: { value: 500, quality: 'lowerBound', scope: 'matches' }, threshold: 500, continueLimit: 25, notices: [], warnings: [] });

export const failure = (code: string, details?: Record<string, unknown>): ApiFailure => ({ code, message: code, traceId: 't-1', retryable: true, ...(details === undefined ? {} : { details }) }) as unknown as ApiFailure;

export interface Sent {
  readonly id: string;
  readonly request: TemplateRunRequest;
  readonly key: string;
  readonly signal: AbortSignal | undefined;
}

export interface PatternsKit {
  readonly state: ClientState;
  readonly banner: BannerController;
  readonly client: ApiClient;
  readonly sent: Sent[];
  readonly searches: unknown[];
  readonly unmount: () => void;
}

export interface KitOptions {
  readonly list?: () => Promise<ApiResult<TemplateListResponse>>;
  readonly run?: (sent: Sent) => Promise<ApiResult<TemplateRunResponse>>;
  readonly nodes?: readonly GraphNode[];
  /** The source's timeout; `null` for a source that does not state one. */
  readonly timeoutMs?: number | null;
  readonly search?: (request: unknown) => Promise<ApiResult<never>>;
}

/** The workspace with the Patterns tool over a graph of accounts (`kind-a`), devices (`kind-b`) and addresses (`kind-c`); the panel is closed. */
export async function patternsWorkspace(options: KitOptions = {}): Promise<PatternsKit> {
  const sent: Sent[] = [];
  const searches: unknown[] = [];
  const client = fakeClient({
    getProfile: async (sourceId) => ({ ok: true, value: profiled(sourceId, ['kind-a', 'kind-b', 'kind-c']) }),
    getMe: async () => ({ ok: true, value: me() }),
    getSources: async () => ({ ok: true, value: { items: [source('a', options.timeoutMs === null ? {} : { timeoutMs: options.timeoutMs ?? 5000 })], nextCursor: null } }),
    listTemplates: options.list ?? (async () => ({ ok: true, value: listOf() })),
    runTemplate: async (id, request, key, signal) => {
      const entry = { id, request, key, signal };
      sent.push(entry);
      return options.run === undefined ? { ok: true, value: okRun(['acc-2']) } : options.run(entry);
    },
    searchEntities: async (request) => {
      searches.push(request);
      return (options.search ?? (async () => searchOf([])))(request) as never;
    },
  });
  const state = createClientState();
  loadGraph(state, options.nodes ?? [typedNode('acc-1', 'kind-a'), typedNode('acc-2', 'kind-a'), typedNode('dev-1', 'kind-b')], []);
  const slots = createSlotRegistry();
  registerBuiltInSlots(slots);
  const tools = createToolRegistry();
  registerBuiltInTools(tools);
  registerFiltersTool(tools, state);
  registerSearchTool(tools, state);
  registerPatternsTool(tools, state);
  const banner = createBuiltInBannerController();
  const view = renderApp('/explore', client, state, slots, stubFactory().create, undefined, tools, undefined, createPanelRegistryFor(state), undefined, banner);
  await settle();
  return { state, banner, client, sent, searches, unmount: view.unmount };
}

export async function settle(): Promise<void> {
  await act(async () => void (await Promise.resolve()));
  await act(async () => void (await Promise.resolve()));
}

export const openPatterns = async (): Promise<void> => {
  fireEvent.click(screen.getByRole('button', { name: 'Patterns' }));
  await settle();
};

export const selectAccount = (state: ClientState, id: string): void => {
  act(() => state.presentation.select([elementKey(ref('a', 'kind-a', id))]));
};
