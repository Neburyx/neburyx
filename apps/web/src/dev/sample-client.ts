import type { StoredEdgeDetail, StoredEdgeRef } from '@neburyx/contracts';
import type { ApiClient } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { FRAME_SAMPLE_SOURCE } from './frame-sample.js';

const BUSY = { code: 'SOURCE_BUSY', message: 'The source is busy.', retryable: true, traceId: 'tr-sample' } as const;

/** The sample's synthetic answer for a stored relationship, by its stable ID: `sample-r-2` kept no records, `sample-r-3` fails once as busy and answers the next ask, the others answer one record. */
function detailOf(ref: StoredEdgeRef): StoredEdgeDetail {
  const end = (entityType: string) => ({ ref: { sourceId: FRAME_SAMPLE_SOURCE, entityType, stableId: entityType }, title: entityType, type: entityType });
  const records = ref.stableId === 'sample-r-1' ? [{ sourceRecordId: 'REC-1', linkable: false }, { sourceRecordId: 'REC-2', linkable: false }] : [{ sourceRecordId: `REC-${ref.stableId}`, linkable: false }];
  return {
    ref,
    type: ref.type,
    semantics: 'stored',
    from: end(ref.from),
    to: end(ref.to),
    observedAt: '2026-10-21T08:15:00Z',
    properties: [{ key: 'remark', value: 'checked', dataClass: 'text', masked: false }],
    qualityFlags: [],
    evidence: ref.stableId === 'sample-r-2' ? { status: 'not-available', code: 'EVIDENCE_NOT_AVAILABLE' } : { status: 'available', records },
  };
}

/** A client whose only read is the stored relationship's, answered from the sample; every other read is unreachable. */
export function sampleClient(): ApiClient {
  const asked = new Set<string>();
  return fakeClient({
    getMe: async () => ({ ok: true, value: { principal: { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', displayName: 'Local user', role: 'administrator' }, edition: 'community', identityMode: 'none', sources: [] } }),
    getSources: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
    getEdge: async (ref) => {
      if ('derived' in ref) return { ok: false, failure: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-sample' } };
      if (ref.stableId === 'sample-r-3' && !asked.has(ref.stableId)) {
        asked.add(ref.stableId);
        return { ok: false, failure: BUSY };
      }
      return { ok: true, value: detailOf(ref) };
    },
  });
}
