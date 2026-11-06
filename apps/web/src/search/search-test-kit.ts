import type { GraphNode, OpenInvestigationRequest, OpenInvestigationResponse, SearchRequest, SearchResult, SourceProfile } from '@neburyx/contracts';
import type { ApiClient, ApiResult } from '../api/client.js';
import { testProfile } from '../dev/test-profile.js';
import { nodeOf } from '../investigations/test-data.js';
import { clientWith, me, source } from '../test-utils.js';

export const TYPE = 'kind-a';

/** The entry of a search in the history: the address holds the source, and the typed text is in the state. */
export function searchAt(source: string, text?: string): { readonly pathname: string; readonly search: string; readonly state?: { readonly q: string } } {
  return { pathname: '/search', search: `?source=${source}`, ...(text === undefined ? {} : { state: { q: text } }) };
}

export function hit(sourceId: string, stableId: string, properties: Record<string, unknown> = {}, entityType = TYPE): GraphNode {
  const node = nodeOf(sourceId, entityType, stableId, `Title ${stableId}`);
  return { ...node, properties: Object.entries(properties).map(([key, value]) => ({ key, value, dataClass: 'text', masked: false })) };
}

export function answerOf(sourceId: string, exact: readonly GraphNode[], overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    sourceId,
    exact: [...exact],
    cap: 25,
    searchable: true,
    counts: { exact: { value: exact.length, quality: 'exact', scope: 'search:exact' } },
    disabledTypes: [],
    dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 },
    warnings: [],
    elapsedMs: 180,
    ...overrides,
  };
}

export function profiled(sourceId: string): SourceProfile {
  const profile = testProfile(sourceId, [TYPE]);
  return { ...profile, entityTypes: profile.entityTypes.map((type) => ({ ...type, keyProperties: ['stableCode', 'tier'], stateProperty: 'status' })) };
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly settle: (value: T) => void;
}

export function deferred<T>(): Deferred<T> {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    settle = done;
  });
  return { promise, settle };
}

export interface SearchKit {
  readonly client: ApiClient;
  readonly searches: SearchRequest[];
  readonly signals: (AbortSignal | undefined)[];
  readonly opens: OpenInvestigationRequest[];
}

/** A client of the given sources whose search is answered by `answer`, which is given each request in turn; every request is recorded. */
export function searchKit(
  sources: readonly string[],
  answer: (request: SearchRequest, signal: AbortSignal | undefined) => Promise<ApiResult<SearchResult>>,
  options: { readonly synthetic?: Record<string, boolean>; readonly open?: (request: OpenInvestigationRequest, signal: AbortSignal | undefined) => Promise<ApiResult<OpenInvestigationResponse>> } = {},
): SearchKit {
  const searches: SearchRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const opens: OpenInvestigationRequest[] = [];
  const base = clientWith({ me: me(), sources: sources.map((id) => source(id, { alias: `Source ${id}`, synthetic: options.synthetic?.[id] ?? true })) });
  return {
    searches,
    signals,
    opens,
    client: {
      ...base,
      getProfile: async (sourceId) => ({ ok: true, value: profiled(sourceId) }),
      openInvestigation: (request, signal) => {
        opens.push(request);
        return options.open === undefined ? base.openInvestigation(request, signal) : options.open(request, signal);
      },
      searchEntities: (request, signal) => {
        searches.push(request);
        signals.push(signal);
        return answer(request, signal);
      },
    },
  };
}
