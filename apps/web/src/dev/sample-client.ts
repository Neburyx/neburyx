import type { AggregateEdgeDetail, AggregateEdgeRef, StoredEdgeDetail, StoredEdgeRef } from '@neburyx/contracts';
import type { ApiClient } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { FRAME_SAMPLE_SOURCE } from './frame-sample.js';

const BUSY = { code: 'SOURCE_BUSY', message: 'The source is busy.', retryable: true, traceId: 'tr-sample' } as const;

/** The sample's synthetic answer for a stored relationship, by its stable ID: `sample-r-2` kept no records, `sample-r-3` fails once as busy and answers the next ask, the others answer one record. */
function detailOf(ref: StoredEdgeRef, linkable: boolean): StoredEdgeDetail {
  const end = (entityType: string) => ({ ref: { sourceId: FRAME_SAMPLE_SOURCE, entityType, stableId: entityType }, title: entityType, type: entityType });
  const records = ref.stableId === 'sample-r-1' ? [{ sourceRecordId: 'REC-1', linkable }, { sourceRecordId: 'REC-2', linkable }] : [{ sourceRecordId: `REC-${ref.stableId}`, linkable }];
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

/** The sample's synthetic answer for an aggregate: 57 members (the canvas draws 42 of them, as after a filtered expansion), an observed range and three sampled members newest first. */
function aggregateDetailOf(ref: AggregateEdgeRef): AggregateEdgeDetail {
  const end = (entity: AggregateEdgeRef['aggregate']['from']) => ({ ref: entity, title: entity.stableId, type: entity.entityType });
  return {
    ref,
    type: ref.aggregate.type,
    semantics: 'aggregate',
    from: end(ref.aggregate.from),
    to: end(ref.aggregate.to),
    members: { value: 57, quality: 'exact', scope: 'aggregate:members' },
    observedFirst: '2026-01-01T10:00:00Z',
    observedLast: '2026-01-28T10:00:00Z',
    sample: { order: 'observed-newest', rows: [28, 27, 26].map((day) => ({ observedAt: `2026-01-${day}T10:00:00Z`, properties: [{ key: 'remark', value: 'web', dataClass: 'text' as const, masked: false }] })), more: 54 },
    qualityFlags: [],
    warnings: [],
  };
}

/** A client whose only read is the stored relationship's, answered from the sample; every other read is unreachable. */
export function sampleClient(linkable = false): ApiClient {
  const asked = new Set<string>();
  return fakeClient({
    getMe: async () => ({ ok: true, value: { principal: { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', displayName: 'Local user', role: 'administrator' }, edition: 'community', identityMode: 'none', sources: [] } }),
    getSources: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
    getEdge: async (ref) => {
      if ('aggregate' in ref) return { ok: true, value: aggregateDetailOf(ref) };
      if ('derived' in ref) return { ok: false, failure: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-sample' } };
      if (ref.stableId === 'sample-r-3' && !asked.has(ref.stableId)) {
        asked.add(ref.stableId);
        return { ok: false, failure: BUSY };
      }
      return { ok: true, value: detailOf(ref, linkable) };
    },
  });
}
