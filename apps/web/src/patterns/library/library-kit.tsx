import { screen } from '@testing-library/react';
import { builtInDefinitionSchema, type ListedPattern, type PatternListResponse, type SourceSummary, type TemplateListResponse } from '@neburyx/contracts';
import type { ApiClient, ApiResult } from '../../api/client.js';
import { fakeClient } from '../../api/fake-client.js';
import { createClientState, type ClientState } from '../../state/client-state.js';
import { clientWith, me, renderApp, source } from '../../test-utils.js';
import { listOf, listed, settle } from '../patterns-kit.js';

export { listed, settle };

interface LibraryCall {
  readonly method: 'listPatterns' | 'changePattern' | 'deletePattern' | 'copyPattern' | 'runSavedPattern';
  readonly args: readonly unknown[];
}

export interface LibraryOptions {
  readonly path?: string;
  readonly sources?: readonly SourceSummary[];
  readonly getSources?: ApiClient['getSources'];
  readonly state?: ClientState;
  readonly templates?: () => Promise<ApiResult<TemplateListResponse>>;
  readonly profile?: ApiClient['getProfile'];
  readonly patterns?: Partial<Pick<ApiClient, 'listPatterns' | 'changePattern' | 'deletePattern' | 'copyPattern' | 'runSavedPattern'>>;
}

export const page = (items: readonly ListedPattern[], nextCursor: string | null = null): ApiResult<PatternListResponse> => ({ ok: true, value: { items: [...items], nextCursor } });

export async function libraryPage(options: LibraryOptions = {}) {
  const calls: LibraryCall[] = [];
  const queries: Array<Parameters<ApiClient['listPatterns']>[0]> = [];
  const saved = options.patterns ?? {};
  const base = clientWith({ me: me(), sources: options.sources ?? [source('a')] });
  const client = fakeClient({
    ...base,
    ...(options.getSources === undefined ? {} : { getSources: options.getSources }),
    ...(options.profile === undefined ? {} : { getProfile: options.profile }),
    listTemplates: options.templates ?? (async () => ({ ok: true, value: listOf() })),
    listPatterns: async (query, signal) => {
      calls.push({ method: 'listPatterns', args: [query, signal] });
      queries.push(query);
      return saved.listPatterns === undefined ? page([]) : saved.listPatterns(query, signal);
    },
    changePattern: async (id, request, signal) => {
      calls.push({ method: 'changePattern', args: [id, request, signal] });
      return saved.changePattern === undefined ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : saved.changePattern(id, request, signal);
    },
    deletePattern: async (id, version, signal) => {
      calls.push({ method: 'deletePattern', args: [id, version, signal] });
      return saved.deletePattern === undefined ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : saved.deletePattern(id, version, signal);
    },
    runSavedPattern: async (id, request, key, signal) => {
      calls.push({ method: 'runSavedPattern', args: [id, request, key, signal] });
      return saved.runSavedPattern === undefined ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : saved.runSavedPattern(id, request, key, signal);
    },
    copyPattern: async (id, signal) => {
      calls.push({ method: 'copyPattern', args: [id, signal] });
      return saved.copyPattern === undefined ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : saved.copyPattern(id, signal);
    },
  });
  const state = options.state ?? createClientState();
  const view = renderApp(options.path ?? '/patterns', client, state);
  await settle();
  return { ...view, calls, queries, client, state };
}

export const tab = (name: RegExp | string): HTMLElement => screen.getByRole('tab', { name });
export const tableRows = (): string[] => screen.getAllByRole('row').slice(1).map((row) => row.textContent ?? '');

export const withDefinition = (): TemplateListResponse => ({
  ...listOf(),
  builtInDefinitions: [builtInDefinitionSchema.parse({ id: 'fan-out', name: 'Fan-out', description: 'One account sends to many.', group: 'AML typologies', tag: 'AML', definition: { anchorType: 'kind-a', steps: [{ relationshipTypes: ['link-a'], direction: 'out', arrivesAt: 'kind-b' }] } })],
});
