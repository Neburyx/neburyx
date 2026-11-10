import type { SourceProfile } from '@neburyx/contracts';
import type { ApiClient, ApiResult } from '../api/client.js';
import { createRequestStore, type RequestStore } from '../api/request-store.js';
import type { RequestState } from '../api/use-request.js';
import type { InvestigationState } from '../state/investigation-state.js';
import { createStore, readable, type ReadableStore } from '../state/store.js';

export interface ProfileState {
  readonly sourceId: string | null;
  readonly request: RequestState<SourceProfile>;
}

export interface ProfileStore extends ReadableStore<ProfileState> {
  readonly reload: () => void;
}

interface Following {
  readonly sourceId: string;
  readonly request: RequestStore<SourceProfile>;
  readonly unsubscribe: () => void;
}

/** The profile that came back names another source than the one asked about, so it is not used. */
const ANSWER_FOR_ANOTHER_SOURCE: ApiResult<never> = { ok: false, failure: { code: 'SCHEMA_MISMATCH' } };

const NONE: ProfileState = { sourceId: null, request: { phase: 'idle' } };

/** Reads the profile of the source the investigation binds, once, when it is bound; another source takes over and the earlier read is dropped. Lives outside React, so rendering twice never asks twice. */
export function createProfileStore(client: ApiClient, investigation: ReadableStore<InvestigationState>): ProfileStore {
  const store = createStore<ProfileState>(NONE);
  let following: Following | undefined;

  const follow = (): void => {
    const held = investigation.getState();
    // a source that is no longer configured has no profile to read: asking would only show a failure on a page that needs none
    const sourceId = held.record?.sourceState === 'removed' ? null : held.sourceId;
    if ((following?.sourceId ?? null) === sourceId) return;
    following?.unsubscribe();
    following?.request.cancel();
    following = undefined;
    if (sourceId === null) {
      store.setState(NONE);
      return;
    }
    const request = createRequestStore(async (signal) => {
      const result = await client.getProfile(sourceId, signal);
      return result.ok && result.value.sourceId !== sourceId ? ANSWER_FOR_ANOTHER_SOURCE : result;
    });
    const publish = (): void => store.setState({ sourceId, request: request.getState() });
    following = { sourceId, request, unsubscribe: request.subscribe(publish) };
    publish();
  };

  investigation.subscribe(follow);
  follow();
  return { ...readable(store), reload: () => following?.request.reload() };
}
