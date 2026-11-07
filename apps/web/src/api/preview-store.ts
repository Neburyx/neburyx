import type { DegreePreview, ElementRef } from '@neburyx/contracts';
import type { ApiClient } from './client.js';
import type { FailureReporter } from './failure-reporter.js';
import { createStore, readable, type ReadableStore } from '../state/store.js';
import { createRequestStore, type RequestStore } from './request-store.js';

export interface PreviewStore {
  /** The request for the degree preview of a node: made once, when the node's menu asks for it, and kept for the session; ask again with its `reload`. */
  forNode(ref: ElementRef, mask: boolean): RequestStore<DegreePreview>;
  /** The answered preview of a node under a masking setting, if one was asked for and has answered; it never asks, so drawing from it costs no request. */
  held(ref: ElementRef, mask: boolean): DegreePreview | undefined;
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
export function createPreviewStore(client: ApiClient, person: () => string, report?: FailureReporter): PreviewStore {
  const requests = new Map<string, RequestStore<DegreePreview>>();
  const changes = createStore(0);
  const answers = createStore(0);
  return {
    view: readable(changes),
    answers: readable(answers),
    held(ref, mask) {
      const state = requests.get(keyOf(person(), ref, mask))?.getState();
      return state?.phase === 'ready' ? state.data : undefined;
    },
    forNode(ref, mask) {
      const key = keyOf(person(), ref, mask);
      const held = requests.get(key);
      if (held !== undefined) return held;
      // the submenu keeps its own line for a failure while it is open, so the store keeps the failure whether or not the banner showed it too
      const request = createRequestStore(
        (signal) => client.previewExpansion({ sourceId: ref.sourceId, ref: { entityType: ref.entityType, stableId: ref.stableId }, ...(mask ? { mask } : {}) }, signal),
        (failure, reload) => void report?.(failure, ref.sourceId, reload),
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
    },
  };
}
