import type { DegreePreview, ExpandResponse } from '@neburyx/contracts';

/**
 * Written, not recorded. The answers of the API for the hub of the 100,000-relationship degree test (one hub with 100,000 outgoing `LINKED` relationships to `leaf` nodes, a heavy-operation threshold of 500): the preview is capped at 500 and says so, the
 * relationship type and the neighbor type are lower bounds, and an expansion answers one page of n with more to read and no total. They are written to the shapes the contracts accept (the tests parse them), not recorded from a running source.
 */
export const hubPreview: DegreePreview = {
  ref: { sourceId: 'a', entityType: 'hub', stableId: 'big' },
  total: { value: 500, quality: 'lowerBound', scope: 'degree:total' },
  byType: [{ relationshipType: 'LINKED', direction: 'out', count: { value: 500, quality: 'lowerBound', scope: 'degree:LINKED:out' }, neighborTypes: ['leaf'] }],
  byNeighborType: [{ entityType: 'leaf', count: { value: 500, quality: 'lowerBound', scope: 'degree:leaf' } }],
  warnings: [{ code: 'counts-capped', reason: 'Counts stop at 500 for this node' }],
  pageSize: 25,
};

/**
 * Written from a recording of a running source's answers for its largest node (184,533 relationships: one type of neighbor with 169,756, another with 14,775, one each of two more; the degree reads were exact, the default page 25) with the names of the
 * source's own mapping replaced by neutral ones. The recording is not kept in this repository.
 */
export const busyHubPreview: DegreePreview = {
  ref: { sourceId: 'a', entityType: 'hub', stableId: 'busy' },
  total: { value: 184_533, quality: 'exact', scope: 'degree:total' },
  byType: [
    { relationshipType: 'LINKED', direction: 'out', count: { value: 169_756, quality: 'exact', scope: 'degree:LINKED:out' }, neighborTypes: ['leaf'] },
    { relationshipType: 'PAID', direction: 'out', count: { value: 14_230, quality: 'exact', scope: 'degree:PAID:out' }, neighborTypes: ['peer'] },
    { relationshipType: 'PAID', direction: 'in', count: { value: 545, quality: 'exact', scope: 'degree:PAID:in' }, neighborTypes: ['peer'] },
  ],
  byNeighborType: [
    { entityType: 'leaf', count: { value: 169_756, quality: 'exact', scope: 'degree:leaf' } },
    { entityType: 'peer', count: { value: 14_775, quality: 'exact', scope: 'degree:peer' } },
  ],
  warnings: [],
  pageSize: 25,
};

const leafNode = (id: string) => ({
  ref: { sourceId: 'a', entityType: 'leaf', stableId: id },
  display: { title: id, type: 'leaf' },
  properties: [],
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
});

/** One page of `size` leaves of the hub, newest first, with more to read. */
export function hubPage(size: number): ExpandResponse {
  const ids = Array.from({ length: size }, (_, at) => `big${at + 1}`);
  return {
    ref: { sourceId: 'a', entityType: 'hub', stableId: 'big' },
    pageSize: size,
    nodes: [{ ...leafNode('big'), ref: { sourceId: 'a', entityType: 'hub', stableId: 'big' }, display: { title: 'big', type: 'hub' } }, ...ids.map(leafNode)],
    edges: ids.map((id) => ({
      ref: { sourceId: 'a', type: 'LINKED', from: 'hub', to: 'leaf', stableId: `l-${id}` },
      from: { sourceId: 'a', entityType: 'hub', stableId: 'big' },
      to: { sourceId: 'a', entityType: 'leaf', stableId: id },
      type: 'LINKED',
      direction: 'out' as const,
      semantics: 'stored' as const,
      properties: [],
      evidenceRefs: [],
      qualityFlags: [],
    })),
    pages: [{ neighborType: 'leaf', returned: size, hasMore: true, nextCursor: 'v1.cursor.mac', matchingTotal: { quality: 'unknown', scope: 'expand:leaf' } }],
    warnings: [],
  };
}
