import { act, fireEvent, screen } from '@testing-library/react';
import { vi } from 'vitest';
import type { GraphNode, SearchRequest, SearchResult } from '@neburyx/contracts';
import type { ApiClient, ApiFailure, ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { node } from '../state/test-data.js';
import { me, renderApp, source, stubFactory, type StubRenderer } from '../test-utils.js';
import { registerBuiltInSlots } from '../workspace/built-in-slots.js';
import { registerBuiltInTools } from '../workspace/built-in-tools.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import { createPanelRegistryFor } from '../workspace/panel-registry.js';
import { createSlotRegistry } from '../workspace/slots.js';
import { createToolRegistry } from '../workspace/tool-registry.js';
import { answerOf, profiled } from './search-test-kit.js';
import { registerSearchTool } from './search-tool.js';
import { TYPEAHEAD_DEBOUNCE_MS } from './use-typeahead.js';

export { TYPEAHEAD_DEBOUNCE_MS };

export interface SentSearch {
  readonly request: SearchRequest;
  readonly signal: AbortSignal | undefined;
  readonly answer: (result: ApiResult<SearchResult>) => void;
}

export interface SentLoad {
  readonly key: string;
  readonly mask: boolean | undefined;
  readonly signal: AbortSignal | undefined;
  readonly answer: (result: ApiResult<GraphNode>) => void;
}

const NO_DROPS = { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 } as const;

/** An answer with both groups: the exact hits and the hits that start with the text, each counted as exact unless the test says otherwise. */
export function searchAnswer(sourceId: string, exact: readonly GraphNode[] = [], startsWith: readonly GraphNode[] = [], overrides: Partial<SearchResult> = {}): SearchResult {
  return answerOf(sourceId, exact, { startsWith: { nodes: [...startsWith], count: { value: startsWith.length, quality: 'exact', scope: 'search:startsWith' }, dropped: { ...NO_DROPS }, warnings: [] }, ...overrides });
}

export const TIMEOUT: ApiFailure = { code: 'QUERY_TIMEOUT', message: 'late', retryable: true, traceId: 'tr-1', details: { timeoutMs: 5000 } };

/** A client whose searches and entity reads wait until the test answers them, so the order of the answers is the test's. */
export function holding(): { readonly client: ApiClient; readonly searches: SentSearch[]; readonly loads: SentLoad[] } {
  const searches: SentSearch[] = [];
  const loads: SentLoad[] = [];
  const client = fakeClient({
    getProfile: async (sourceId) => ({ ok: true, value: profiled(sourceId) }),
    getMe: async () => ({ ok: true, value: me() }),
    getSources: async () => ({ ok: true, value: { items: [source('a')], nextCursor: null } }),
    searchEntities: (request, signal) => new Promise<ApiResult<SearchResult>>((resolve) => void searches.push({ request, signal, answer: resolve })),
    getEntity: (ref, options, signal) => new Promise<ApiResult<GraphNode>>((resolve) => void loads.push({ key: `${ref.entityType}/${ref.stableId}`, mask: options?.mask, signal, answer: resolve })),
  });
  return { client, searches, loads };
}

export const settle = (): Promise<void> => act(async () => void (await Promise.resolve()));
export const wait = (ms: number): Promise<void> => act(async () => void vi.advanceTimersByTime(ms));

export interface PanelWorkspace {
  readonly client: ApiClient;
  readonly searches: SentSearch[];
  readonly loads: SentLoad[];
  readonly state: ClientState;
  readonly renderer: () => StubRenderer | undefined;
  readonly router: ReturnType<typeof renderApp>['router'];
}

/** The workspace with the Search panel open on the Add from source tab, under fake timers; a graph is loaded unless `bound` is false. */
export async function panelWorkspace(options: { readonly bound?: boolean; readonly mask?: boolean; readonly nodes?: readonly GraphNode[] } = {}): Promise<PanelWorkspace> {
  const { client, searches, loads } = holding();
  const state = createClientState();
  if (options.bound !== false) loadGraph(state, [...(options.nodes ?? [node('a', 'ACC-1')])], []);
  if (options.mask === true) state.setMask(true);
  const slots = createSlotRegistry();
  registerBuiltInSlots(slots);
  const tools = createToolRegistry();
  registerBuiltInTools(tools);
  registerSearchTool(tools, state);
  const factory = stubFactory();
  const view = renderApp('/explore', client, state, slots, factory.create, undefined, tools, undefined, createPanelRegistryFor(state));
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Add from source' }));
  return { client, searches, loads, state, router: view.router, renderer: () => factory.made[0] };
}

export function inputOf(element: HTMLElement): HTMLInputElement {
  if (!(element instanceof HTMLInputElement)) throw new Error('the element is not an input');
  return element;
}

export const sourceBox = (): HTMLElement => screen.getByRole('searchbox', { name: 'Find in the source' });
export const setText = (value: string): void => void fireEvent.change(sourceBox(), { target: { value } });

/** Types a text a character at a time, 10 ms apart, as fast typing does. */
export async function typeText(text: string): Promise<void> {
  const characters = Array.from(text);
  for (let at = 1; at <= characters.length; at += 1) {
    setText(characters.slice(0, at).join(''));
    await wait(10);
  }
}

/** Types the text and waits for the delay, so the request is sent. */
export async function searchFor(text: string): Promise<void> {
  await typeText(text);
  await wait(TYPEAHEAD_DEBOUNCE_MS);
}
