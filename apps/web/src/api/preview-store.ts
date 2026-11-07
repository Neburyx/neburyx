import type { DegreePreview, ElementRef } from '@neburyx/contracts';
import type { ApiClient } from './client.js';
import { createRequestStore, type RequestStore } from './request-store.js';

export interface PreviewStore {
  /** The request for the degree preview of a node: made once, when the node's menu asks for it, and kept for the session; ask again with its `reload`. */
  forNode(ref: ElementRef, mask: boolean): RequestStore<DegreePreview>;
}

const keyOf = (person: string, ref: ElementRef, mask: boolean): string => JSON.stringify([person, ref.sourceId, ref.entityType, ref.stableId, mask]);

/**
 * The previews a person's session has asked for, each a request store of its own under the person (as `person` names them when the ask is made), source, node and mask setting that asked, so an answer for one node is never shown
 * for another, and an answer that arrives late lands under the key it was asked for. A failure is held as a failure (the store's `reload` asks again) and is never an answer.
 */
export function createPreviewStore(client: ApiClient, person: () => string): PreviewStore {
  const requests = new Map<string, RequestStore<DegreePreview>>();
  return {
    forNode(ref, mask) {
      const key = keyOf(person(), ref, mask);
      const held = requests.get(key);
      if (held !== undefined) return held;
      const request = createRequestStore((signal) => client.previewExpansion({ sourceId: ref.sourceId, ref: { entityType: ref.entityType, stableId: ref.stableId }, ...(mask ? { mask } : {}) }, signal));
      requests.set(key, request);
      return request;
    },
  };
}
