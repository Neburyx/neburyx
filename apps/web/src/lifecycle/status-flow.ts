import type { ApiClient, ApiFailure } from '../api/client.js';
import type { BannerController } from '../banner/banner-controller.js';
import type { ClientState } from '../state/client-state.js';
import { isReadOnlyStatus, type InvestigationStatus } from '../state/investigation-state.js';
import { createStore, readable, type ReadableStore } from '../state/store.js';
import { FAILURE_BANNER_ID, FAILURE_CHIP, FAILURE_TEXT, UNKNOWN_OUTCOME_TEXT, NETWORK_FAILURE, RELOAD, SCHEMA_FAILURE } from './copy.js';
import { refreshRecord } from './refresh-record.js';

export interface LifecycleDeps {
  readonly client: ApiClient;
  readonly state: ClientState;
  readonly banner: BannerController;
}

const busyStores = new WeakMap<ClientState, ReturnType<typeof createStore<boolean>>>();

function busyStoreOf(state: ClientState): ReturnType<typeof createStore<boolean>> {
  let store = busyStores.get(state);
  if (store === undefined) {
    store = createStore<boolean>(false);
    busyStores.set(state, store);
  }
  return store;
}

/** True while a status change of the investigation shown is in flight, so a second choice sends nothing. */
export function statusChangeBusy(state: ClientState): ReadableStore<boolean> {
  return readable(busyStoreOf(state));
}

/** The words a failed call is shown with: its own message when the server gave one. */
export function messageOf(failure: ApiFailure): string {
  if ('message' in failure) return failure.message;
  return failure.code === 'SCHEMA_MISMATCH' ? SCHEMA_FAILURE : NETWORK_FAILURE;
}

export function isReadOnlyRefusal(failure: ApiFailure): boolean {
  return failure.code === 'CONFLICT' && 'details' in failure && failure.details?.reason === 'investigation-read-only';
}

/** Shows a failed call as a request banner; a `CONFLICT` offers Reload, which reads the investigation again. */
export function showFailure(deps: LifecycleDeps, failure: ApiFailure, investigationId: string): void {
  const reload = failure.code === 'CONFLICT' || !('traceId' in failure);
  deps.banner.show({
    id: FAILURE_BANNER_ID,
    tone: 'danger',
    chip: FAILURE_CHIP,
    headline: messageOf(failure),
    text: 'traceId' in failure ? FAILURE_TEXT : UNKNOWN_OUTCOME_TEXT,
    actions: reload
      ? [
          {
            id: 'reload',
            label: RELOAD,
            primary: true,
            run: () => {
              void refreshRecord(deps.client, deps.state, investigationId).then((refreshed) => {
                if (refreshed) deps.banner.dismiss(FAILURE_BANNER_ID);
                else showFailure(deps, { code: 'NETWORK_UNAVAILABLE' }, investigationId);
              });
            },
          },
        ]
      : [],
  });
}

/** Moves the investigation shown to another status: the record takes the answer, or the failure is shown and the record stays. Nothing is sent while a change is under way. */
export async function changeStatus(deps: LifecycleDeps, status: InvestigationStatus): Promise<'changed' | 'failed' | 'skipped'> {
  const busy = busyStoreOf(deps.state);
  const { id, record } = deps.state.investigation.getState();
  if (busy.getState() || id === null || record === null) return 'skipped';
  busy.setState(true);
  deps.banner.dismiss(FAILURE_BANNER_ID);
  try {
    const result = await deps.client.changeInvestigationStatus(id, status, record.version);
    if (!result.ok) {
      if (deps.state.investigation.getState().id === id) showFailure(deps, result.failure, id);
      return 'failed';
    }
    const held = deps.state.investigation.getState();
    if (held.id === id && held.record !== null) {
      const { investigation } = result.value;
      deps.state.describeInvestigation({ ...held.record, title: investigation.title, status: investigation.status, readOnly: isReadOnlyStatus(investigation.status), version: investigation.version });
    }
    return 'changed';
  } finally {
    busy.setState(false);
  }
}
