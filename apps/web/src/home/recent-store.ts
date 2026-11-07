import type { InvestigationListItem, InvestigationListResponse, SourceProfile } from '@neburyx/contracts';
import type { ApiClient } from '../api/client.js';
import { createRequestStore, type RequestStore } from '../api/request-store.js';
import type { RequestState } from '../api/use-request.js';
import { createStore, readable, type ReadableStore } from '../state/store.js';
import { RECENT_LIMIT } from './copy.js';

export interface RecentState {
  readonly list: RequestState<InvestigationListResponse>;
  readonly profiles: ReadonlyMap<string, RequestState<SourceProfile>>;
  /** The visit that asked for the list read the state belongs to, so a page can tell its own answer from an earlier visit's. */
  readonly readBy: object | undefined;
}

export interface RecentInvestigations extends ReadableStore<RecentState> {
  /** Asks for the list on behalf of a visit. A read under way that this visit asked for is not repeated, so the two effects of StrictMode ask once; one that an earlier visit asked for is asked again, so its answer cannot pass for this visit's. */
  readonly ensure: (visit: object) => void;
  readonly reload: () => void;
}

export function createRecentInvestigations(client: ApiClient): RecentInvestigations {
  const state = createStore<RecentState>({ list: { phase: 'idle' }, profiles: new Map(), readBy: undefined });
  let readBy: object | undefined;
  const profileRequests = new Map<string, RequestStore<SourceProfile>>();
  let list: RequestStore<InvestigationListResponse> | undefined;

  const publishProfile = (sourceId: string, request: RequestStore<SourceProfile>): void => {
    state.setState({ ...state.getState(), profiles: new Map(state.getState().profiles).set(sourceId, request.getState()) });
  };

  const readProfiles = (items: readonly InvestigationListItem[]): void => {
    for (const sourceId of new Set(items.map((item) => item.sourceId))) {
      const existing = profileRequests.get(sourceId);
      if (existing !== undefined) {
        existing.reload();
        continue;
      }
      const request = createRequestStore(async (signal) => {
        const result = await client.getProfile(sourceId, signal);
        return result.ok && result.value.sourceId !== sourceId ? ({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } } as const) : result;
      });
      profileRequests.set(sourceId, request);
      request.subscribe(() => publishProfile(sourceId, request));
      publishProfile(sourceId, request);
    }
  };

  const start = (): RequestStore<InvestigationListResponse> => {
    const started = createRequestStore(async (signal) => {
      const result = await client.listInvestigations(RECENT_LIMIT, signal);
      if (result.ok && !signal.aborted) readProfiles(result.value.items);
      return result;
    });
    started.subscribe(() => state.setState({ ...state.getState(), list: started.getState() }));
    state.setState({ ...state.getState(), list: started.getState() });
    return started;
  };

  return {
    ...readable(state),
    ensure: (visit) => {
      if (list !== undefined && readBy === visit && list.getState().phase === 'loading') return;
      readBy = visit;
      state.setState({ ...state.getState(), readBy: visit });
      if (list === undefined) list = start();
      else list.reload();
    },
    reload: () => {
      if (list === undefined) list = start();
      else list.reload();
    },
  };
}
