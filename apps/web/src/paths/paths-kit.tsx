import { act, fireEvent, screen, within } from '@testing-library/react';
import type { ElementRef, GraphEdge, GraphNode, PathsOk, PathsRequest, PathsResponse, SearchRequest, SearchResult } from '@neburyx/contracts';
import { searchOf } from '../patterns/search-kit.js';
import { fakeClient } from '../api/fake-client.js';
import type { ApiClient, ApiResult } from '../api/client.js';
import { createBuiltInBannerController } from '../banner/built-in-causes.js';
import type { BannerController } from '../banner/banner-controller.js';
import { createEvidence, type Evidence } from '../evidence/evidence.js';
import { storedEvidenceKind } from '../evidence/stored-evidence.js';
import { profiled } from '../search/search-test-kit.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { edgeRef, ref } from '../state/test-data.js';
import { builtInKeyBindings, me, renderApp, source, stubFactory } from '../test-utils.js';
import { bindPathsActions } from './paths-actions.js';
import { registerBuiltInMenuItems } from '../workspace/built-in-menu-items.js';
import { createMenuRegistry, type MenuRegistry } from '../workspace/menu-registry.js';
import type { KeyBindingRegistry } from '../workspace/key-binding-registry.js';
import { createSelectionActionRegistry } from '../workspace/selection-actions.js';
import { registerBuiltInSlots } from '../workspace/built-in-slots.js';
import { registerBuiltInTools } from '../workspace/built-in-tools.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import { typedNode } from '../workspace/filters-kit.js';
import { registerFiltersTool } from '../workspace/filters-tool.js';
import { createPanelRegistryFor } from '../workspace/panel-registry.js';
import { createSlotRegistry } from '../workspace/slots.js';
import { createToolRegistry } from '../workspace/tool-registry.js';
import { registerPathsTool } from './paths-tool.js';

export interface SentSearch {
  readonly request: PathsRequest;
  readonly signal: AbortSignal | undefined;
}

export interface PathsKit {
  readonly state: ClientState;
  readonly banner: BannerController;
  readonly client: ApiClient;
  readonly sent: SentSearch[];
  readonly searches: SearchRequest[];
  readonly evidence: Evidence;
  readonly menus: MenuRegistry;
  readonly keyBindings: KeyBindingRegistry;
  readonly unmount: () => void;
}

export interface PathsKitOptions {
  readonly nodes?: readonly GraphNode[];
  readonly edges?: readonly GraphEdge[];
  readonly find?: (sent: SentSearch) => Promise<ApiResult<PathsResponse>>;
  readonly timeoutMs?: number;
  readonly maxHops?: number;
  readonly search?: (request: SearchRequest, signal: AbortSignal | undefined) => Promise<ApiResult<SearchResult>>;
}

export const nodeRef = (id: string, entityType = 'kind-a') => ref('a', entityType, id);

const edgeOf = (step: { readonly from: ElementRef; readonly to: ElementRef }, evidence: readonly string[]): GraphEdge => ({
  ref: edgeRef('a', `e-${step.from.stableId}-${step.to.stableId}`, 'link-a', 'kind-a', 'kind-a'),
  from: step.from,
  to: step.to,
  type: 'link-a',
  direction: 'from-to',
  semantics: 'stored',
  properties: [],
  evidenceRefs: [...evidence],
  qualityFlags: [],
});

/** The answer of a search whose paths are the given chains of entity IDs (all of `kind-a`), each step one relationship `link-a`. */
export function okPaths(chains: readonly (readonly string[])[], overrides: Partial<PathsOk> = {}, evidence: readonly string[] = []): PathsResponse {
  const ids = [...new Set(chains.flat())];
  const steps = chains.map((chain) => chain.slice(1).map((id, index) => ({ from: nodeRef(chain[index] ?? id), to: nodeRef(id), relationshipType: 'link-a', evidenceRefs: [...evidence] })));
  const edges = new Map(steps.flat().map((step) => [`e-${step.from.stableId}-${step.to.stableId}`, edgeOf(step, evidence)]));
  return {
    status: 'ok',
    paths: steps.map((chainSteps) => ({ hops: chainSteps.length, steps: chainSteps })),
    nodes: ids.map((id) => typedNode(id, 'kind-a')),
    edges: [...edges.values()],
    capReached: false,
    partial: false,
    elapsedMs: 420,
    warnings: [],
    ...overrides,
  };
}

/** The workspace with the Paths tool over a graph of accounts (`kind-a`) and devices (`kind-b`); the panel is closed. */
export async function pathsWorkspace(options: PathsKitOptions = {}): Promise<PathsKit> {
  const sent: SentSearch[] = [];
  const searches: SearchRequest[] = [];
  const client = fakeClient({
    getProfile: async (sourceId) => ({ ok: true, value: profiled(sourceId, ['kind-a', 'kind-b', 'kind-c']) }),
    getMe: async () => ({ ok: true, value: me() }),
    getSources: async () => ({ ok: true, value: { items: [source('a', { timeoutMs: options.timeoutMs ?? 5000, ...(options.maxHops === undefined ? {} : { maxHops: options.maxHops }) })], nextCursor: null } }),
    searchEntities: async (request, signal) => {
      searches.push(request);
      return options.search === undefined ? searchOf([]) : options.search(request, signal);
    },
    findPaths: async (request, signal) => {
      const entry = { request, signal };
      sent.push(entry);
      return options.find === undefined ? { ok: true, value: okPaths([['acc-1', 'acc-2']]) } : options.find(entry);
    },
  });
  const state = createClientState();
  loadGraph(state, options.nodes ?? [typedNode('acc-1', 'kind-a'), typedNode('acc-2', 'kind-a'), typedNode('dev-1', 'kind-b')], options.edges ?? []);
  state.describeInvestigation({ title: 'T', caseRef: null, status: 'open', readOnly: false, version: 1, save: { kind: 'unsaved' }, sourceState: 'available', startingEntity: { entityType: 'kind-a', stableId: 'acc-1' } });
  const slots = createSlotRegistry();
  registerBuiltInSlots(slots);
  const tools = createToolRegistry();
  registerBuiltInTools(tools);
  registerFiltersTool(tools, state);
  registerPathsTool(tools, state);
  const menus = createMenuRegistry();
  registerBuiltInMenuItems(menus);
  const selectionActions = createSelectionActionRegistry();
  const keyBindings = builtInKeyBindings();
  bindPathsActions(state, menus, selectionActions, keyBindings);
  const banner = createBuiltInBannerController();
  const evidence = createEvidence();
  evidence.kinds.register(storedEvidenceKind);
  const view = renderApp('/explore', client, state, slots, stubFactory().create, selectionActions, tools, menus, createPanelRegistryFor(state), keyBindings, banner, evidence);
  await settle();
  return { state, banner, client, sent, searches, evidence, menus, keyBindings, unmount: view.unmount };
}

export async function settle(): Promise<void> {
  await act(async () => void (await Promise.resolve()));
  await act(async () => void (await Promise.resolve()));
}

export const openPaths = async (): Promise<void> => {
  fireEvent.click(screen.getByRole('button', { name: 'Paths' }));
  await settle();
};

/** Chooses the entity of an end by its title: types it into the field and picks the option that carries it. */
export const chooseEnd = (label: 'From' | 'To', title: string): void => {
  const input = screen.getByLabelText(label);
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: title } });
  const option = within(screen.getByRole('listbox', { name: `${label} results` })).getAllByRole('option').find((candidate) => candidate.textContent === title || candidate.textContent?.startsWith(`${title} (`) === true);
  if (option === undefined) throw new Error(`no option for ${title}`);
  fireEvent.click(option);
};

/** The group of relationship-type checkboxes, opened first when the control is collapsed. */
export const typesGroup = (): HTMLElement => {
  const toggle = screen.getByRole('button', { name: /^Allowed relationships/ });
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
  return screen.getByRole('group', { name: 'Allowed relationships' });
};

const nodeRefFor = (title: string) => nodeRef(title, title.startsWith('dev') ? 'kind-b' : 'kind-a');
