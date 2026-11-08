import type { DegreePreview, ElementRef } from '@neburyx/contracts';
import type { ApiClient } from './client.js';
import type { RequestTracker } from '../banner/request-tracker.js';
import type { FailureReporter } from './failure-reporter.js';
import { createStore, readable, type ReadableStore } from '../state/store.js';
import { createRequestStore, type RequestStore } from './request-store.js';
import type { RequestState } from './use-request.js';

export interface PreviewStore {
  /** The request for the degree preview of a node: made once, when the node's menu asks for it, and kept for the session; ask again with its `reload`. */
  forNode(ref: ElementRef, mask: boolean): RequestStore<DegreePreview>;
  /** The answered preview of a node under a masking setting, if one was asked for and has answered; it never asks, so drawing from it costs no request. */
  held(ref: ElementRef, mask: boolean): DegreePreview | undefined;
  /** The preview of a node for a check made before an expansion: the answered one, one still on its way awaited, or a read of its own whose failure is neither reported nor kept (undefined then). A successful read is kept for the menus. */
  settle(ref: ElementRef, mask: boolean): Promise<DegreePreview | undefined>;
  /** Changes whenever any held request changes. */
  readonly view: ReadableStore<number>;
  /** How many previews have been answered, counting each answer once; it changes when a preview arrives, so what depends on the previews can ask again. */
  readonly answers: ReadableStore<number>;
}

const keyOf = (person: string, ref: ElementRef, mask: boolean): string => JSON.stringify([person, ref.sourceId, ref.entityType, ref.stableId, mask]);

/**
 * The previews a person's session has asked for, each a request store of its own under the person (as `person` names them when the ask is made), source, node and mask setting that asked, so an answer for one node is never shown
 * for another, and an answer that arrives late lands under the key it was asked for. A failure is held as a failure (the store's `reload` asks again) and is never an answer.
 */
export function createPreviewStore(client: ApiClient, person: () => string, report?: FailureReporter, tracker?: RequestTracker): PreviewStore {
  const requests = new Map<string, RequestStore<DegreePreview>>();
  const changes = createStore(0);
  const answers = createStore(0);
  const open = (ref: ElementRef, mask: boolean, reported: boolean): RequestStore<DegreePreview> => {
    const key = keyOf(person(), ref, mask);
    const held = requests.get(key);
    if (held !== undefined) return held;
    // the submenu keeps its own line for a failure while it is open, so the store keeps the failure whether or not the banner showed it too
    // only the menu's own request is shown on the banner: a read made for the check before an expansion is waited for by that check, which a cancel would leave waiting
    const shown = reported ? tracker : undefined;
    const request: RequestStore<DegreePreview> = createRequestStore(
      (signal) => {
        const tracked = shown?.begin({ kind: 'preview', ref, cancel: () => request.cancel(), again: () => request.reload() });
        return client.previewExpansion({ sourceId: ref.sourceId, ref: { entityType: ref.entityType, stableId: ref.stableId }, ...(mask ? { mask } : {}) }, signal).finally(() => tracked?.finish());
      },
      reported ? (failure, reload) => void report?.(failure, ref.sourceId, reload) : undefined,
    );
    requests.set(key, request);
    request.subscribe(() => changes.setState(changes.getState() + 1));
    let counted: unknown;
    request.subscribe(() => {
      const state = request.getState();
      if (state.phase !== 'ready' || state.data === counted) return;
      counted = state.data;
      answers.setState(answers.getState() + 1);
    });
    return request;
  };
  return {
    view: readable(changes),
    answers: readable(answers),
    held(ref, mask) {
      const state = requests.get(keyOf(person(), ref, mask))?.getState();
      return state?.phase === 'ready' ? state.data : undefined;
    },
    forNode: (ref, mask) => open(ref, mask, true),
    async settle(ref, mask) {
      const key = keyOf(person(), ref, mask);
      const held = requests.get(key);
      // a menu's request that failed earlier, or that the person cancelled, is not an answer: read once more, quietly, and keep nothing of it
      const heldPhase = held?.getState().phase;
      if (heldPhase === 'failed' || heldPhase === 'idle') {
        const result = await client.previewExpansion({ sourceId: ref.sourceId, ref: { entityType: ref.entityType, stableId: ref.stableId }, ...(mask ? { mask } : {}) }).catch(() => undefined);
        return result?.ok === true ? result.value : undefined;
      }
      const request = held ?? open(ref, mask, false);
      const settled = await new Promise<RequestState<DegreePreview>>((resolve) => {
        const now = request.getState();
        if (now.phase !== 'loading') return resolve(now);
        const stop = request.subscribe(() => {
          const next = request.getState();
          if (next.phase === 'loading') return;
          // the person cancelled the request this check waits for: the check goes on with no preview, and never waits for one that will not come
          stop();
          resolve(next);
        });
      });
      if (settled.phase === 'ready') return settled.data;
      // a read the check made itself leaves nothing behind when it failed, so the menu asks afresh
      if (held === undefined && requests.get(key) === request) requests.delete(key);
      return undefined;
    },
  };
}
