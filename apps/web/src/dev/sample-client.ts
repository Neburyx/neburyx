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

const PICTURE_TIME = '2026-11-10T10:15:00.000Z';

/** The window property that holds the export requests the sample was sent, for a browser test to read. */
const SAMPLE_EXPORT_REQUESTS = 'sampleExportRequests';

/** The sample with the Export button's answers: a picture is answered with a header counting the references it was sent, any other format is refused. Each request is added to `window[SAMPLE_EXPORT_REQUESTS]`. */
export function sampleExportClient(): ApiClient {
  const sent: unknown[] = [];
  Reflect.set(window, SAMPLE_EXPORT_REQUESTS, sent);
  return {
    ...sampleClient(),
    createExport: (_id, request) => {
      sent.push(request);
      if (request.format !== 'png') return Promise.resolve({ ok: false, failure: { code: 'EXPORT_FAILED', message: 'Only a picture can be made here.', retryable: false, traceId: 'tr-sample' } });
      const shown = request.entities.length;
      const lines = [`source: ${FRAME_SAMPLE_SOURCE}`, `exported: ${PICTURE_TIME}`, 'scope: current view (partial)', `coverage: ${shown} shown · ~38 not yet retrieved (estimated)`, 'masking: off'];
      const header = { source: FRAME_SAMPLE_SOURCE, exported: PICTURE_TIME, scope: 'current view (partial)' as const, coverage: { shown, notRetrieved: { value: 38, quality: 'estimated' as const, scope: 'not yet retrieved' }, uncounted: 0 }, masking: 'off' as const, lines };
      return Promise.resolve({ ok: true, value: { format: 'png', filename: 'neburyx-export-20261110T101500Z.png', header } });
    },
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
