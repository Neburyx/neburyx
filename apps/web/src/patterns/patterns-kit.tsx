import { act, fireEvent, screen } from '@testing-library/react';
import { paramsJsonSchemaOf, type PatternValidateRequest, type PatternValidateResponse, type PatternPreviewRequest, type PatternPreviewResponse, type PatternRunRequest, type PatternRunResponse, type SourceProfile, type GraphEdge, type GraphNode, type TemplateListResponse, type TemplateRunRequest, type TemplateRunResponse } from '@neburyx/contracts';
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
import type { Evidence } from '../evidence/evidence.js';
import { createEvidence } from '../evidence/evidence.js';
import { storedEvidenceKind } from '../evidence/stored-evidence.js';
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

/** A preview of the pattern the builder tests build: the words are the server's, so the tests only need distinct, findable ones. */
export const PREVIEW = {
  start: { type: 'n-a', name: 'N-A', text: 'Starts at an N-A.' },
  steps: [{ relationshipTypes: ['r-1'], direction: 'out' as const, arrivesAt: { type: 'n-b', name: 'N-B' }, text: 'Follows r-1 outgoing to an N-B.', conditions: [], }],
  bounds: { hopLimit: { value: 4, text: 'At most 4 steps.' }, pageLimit: { value: 50, text: 'At most 50 results at a time.' }, countCap: { value: 500, text: 'Counts stop at 500.' } },
};

/** The `ok` answer of a pattern run: each match is one hop from the anchor, with the shared entity and edge of the scripted ring. */
export const definitionOk = (matches: readonly string[], overrides: Partial<Extract<PatternRunResponse, { status: 'ok' }>> = {}): PatternRunResponse => {
  const nodes = [typedNode('acc-1', 'kind-a'), typedNode('dev-1', 'kind-b'), ...matches.map((id) => typedNode(id, 'kind-a'))];
  const edges: GraphEdge[] = matches.map((id, index) => ({ ...edgeOf('a', `p${index}`, id, 'dev-1'), from: ref('a', 'kind-a', id), to: ref('a', 'kind-b', 'dev-1'), evidenceRefs: [`REC-${index}`] }));
  return {
    status: 'ok',
    templateVersion: '1',
    count: { value: matches.length, quality: 'exact', scope: 'matches' },
    matches: matches.map((id) => ({ match: ref('a', 'kind-a', id), hops: 1 as const, through: [], relationships: [{ relationshipType: 'r-1', from: ref('a', 'kind-a', 'acc-1'), to: ref('a', 'kind-a', id) }] })),
    nodes,
    edges,
    notices: [],
    warnings: [],
    ...overrides,
  } as PatternRunResponse;
};

export const definitionHeavy = (): PatternRunResponse => ({ status: 'heavy', templateVersion: '1', estimate: { value: 500, quality: 'lowerBound', scope: 'matches' }, threshold: 500, continueLimit: 25, notices: [], warnings: [] });

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
  /** The definitions the builder asked the server about, in order. */
  readonly validations: PatternValidateRequest[];
  /** The definitions the builder asked the server to put in words, in order. */
  readonly previews: PatternPreviewRequest[];
  /** The pattern runs the builder sent, with their key and signal, in order. */
  readonly definitionRuns: Array<{ readonly request: PatternRunRequest; readonly key: string; readonly signal: AbortSignal | undefined }>;
  readonly evidence: Evidence;
  readonly unmount: () => void;
}

export interface KitOptions {
  readonly list?: () => Promise<ApiResult<TemplateListResponse>>;
  readonly run?: (sent: Sent) => Promise<ApiResult<TemplateRunResponse>>;
  readonly nodes?: readonly GraphNode[];
  /** The source's timeout; `null` for a source that does not state one. */
  readonly timeoutMs?: number | null;
  /** The profile of the source; the three-type profile of the other tests by default. A promise that never settles keeps it loading. */
  readonly profile?: () => Promise<ApiResult<SourceProfile>>;
  /** The step limit of the source summary; none by default. */
  readonly maxHops?: number;
  readonly preview?: (request: PatternPreviewRequest, signal: AbortSignal | undefined) => Promise<ApiResult<PatternPreviewResponse>>;
  readonly runDefinition?: (request: PatternRunRequest, key: string, signal: AbortSignal | undefined) => Promise<ApiResult<PatternRunResponse>>;
  readonly validate?: (request: PatternValidateRequest, signal: AbortSignal | undefined) => Promise<ApiResult<PatternValidateResponse>>;
  /** The entity the investigation was opened on; the first account by default, `null` for none. */
  readonly opened?: { readonly entityType: string; readonly stableId: string } | null;
  readonly search?: (request: unknown) => Promise<ApiResult<never>>;
}

/** The workspace with the Patterns tool over a graph of accounts (`kind-a`), devices (`kind-b`) and addresses (`kind-c`); the panel is closed. */
export async function patternsWorkspace(options: KitOptions = {}): Promise<PatternsKit> {
  const sent: Sent[] = [];
  const searches: unknown[] = [];
  const validations: PatternValidateRequest[] = [];
  const previews: PatternPreviewRequest[] = [];
  const definitionRuns: PatternsKit['definitionRuns'] = [];
  const client = fakeClient({
    getProfile: options.profile ?? (async (sourceId) => ({ ok: true, value: profiled(sourceId, ['kind-a', 'kind-b', 'kind-c']) })),
    previewPattern: async (request, signal) => {
      previews.push(request);
      return options.preview === undefined ? { ok: true, value: { status: 'ok', preview: PREVIEW } } : options.preview(request, signal);
    },
    runPattern: async (request, key, signal) => {
      definitionRuns.push({ request, key, signal });
      return options.runDefinition === undefined ? { ok: true, value: definitionOk(['acc-2']) } : options.runDefinition(request, key, signal);
    },
    validatePattern: async (request, signal) => {
      validations.push(request);
      return options.validate === undefined ? { ok: true, value: { status: 'ok' } } : options.validate(request, signal);
    },
    getMe: async () => ({ ok: true, value: me() }),
    getSources: async () => ({ ok: true, value: { items: [source('a', { ...(options.timeoutMs === null ? {} : { timeoutMs: options.timeoutMs ?? 5000 }), ...(options.maxHops === undefined ? {} : { maxHops: options.maxHops }) })], nextCursor: null } }),
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
  state.describeInvestigation({ title: 'T', caseRef: null, status: 'open', readOnly: false, version: 1, save: { kind: 'unsaved' }, sourceState: 'available', startingEntity: options.opened === undefined ? { entityType: 'kind-a', stableId: 'acc-1' } : options.opened });
  const slots = createSlotRegistry();
  registerBuiltInSlots(slots);
  const tools = createToolRegistry();
  registerBuiltInTools(tools);
  registerFiltersTool(tools, state);
  registerSearchTool(tools, state);
  registerPatternsTool(tools, state);
  const banner = createBuiltInBannerController();
  const evidence = createEvidence();
  evidence.kinds.register(storedEvidenceKind);
  const view = renderApp('/explore', client, state, slots, stubFactory().create, undefined, tools, undefined, createPanelRegistryFor(state), undefined, banner, evidence);
  await settle();
  return { state, banner, client, sent, searches, validations, previews, definitionRuns, evidence, unmount: view.unmount };
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
