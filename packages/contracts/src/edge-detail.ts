import { z } from 'zod';
import { jsonOfSegment, segmentOfJson } from './ref-segment.js';
import { aggregateSchema, countSchema, elementRefSchema, propertySchema, storedEdgeRefSchema, type ElementRef, type StoredEdgeRef } from './graph.js';

/** The longest `{ref}` segment of `GET /v1/edges/{ref}`: a stored reference is about 300 characters as JSON and a third more as base64url. */
export const MAX_EDGE_REF_SEGMENT = 2048;

/** The one state of an edge whose source kept no records: it travels as a state inside a `200` answer and is never an error response. */
export const EVIDENCE_NOT_AVAILABLE = 'EVIDENCE_NOT_AVAILABLE';

const text = z.string().min(1);

/** One end of an edge: its entity reference, the title the redact stage left it and the display name of its entity type. */
export const edgeEndSchema = z.strictObject({ ref: elementRefSchema, title: z.string(), type: text });

/** A supporting source record: its ID as text (a link only when the mapping says so; no URL is ever sent), or the property whose value could not be shown. */
export const edgeEvidenceRecordSchema = z.union([z.strictObject({ sourceRecordId: text, linkable: z.boolean() }), z.strictObject({ property: text, unreadable: z.literal(true) })]);

export const edgeEvidenceSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), records: z.array(edgeEvidenceRecordSchema).min(1) }),
  z.strictObject({ status: z.literal('not-available'), code: z.literal(EVIDENCE_NOT_AVAILABLE) }),
]);

/** What `GET /v1/edges/{ref}` answers for a stored edge. There is no confidence or score field, and no member element ID or source-record URL. */
export const storedEdgeDetailSchema = z.strictObject({
  ref: storedEdgeRefSchema,
  type: text,
  semantics: z.literal('stored'),
  from: edgeEndSchema,
  to: edgeEndSchema,
  /** The time the mapping's `observed_at` gives, as the source gave it. */
  observedAt: text.optional(),
  properties: z.array(propertySchema),
  qualityFlags: z.array(z.string()),
  evidence: edgeEvidenceSchema,
});

/** The reference of a derived edge: the rule and the two entities it joins. */
export const derivedEdgeRefSchema = z.strictObject({ sourceId: text, derived: z.strictObject({ ruleId: text, from: elementRefSchema, to: elementRefSchema }) });

/** The reference of an aggregate edge: all relationships of one type between two entities, none of which has a stable ID. */
export const aggregateEdgeRefSchema = z.strictObject({ sourceId: text, aggregate: aggregateSchema });

/** The state of a support whose relationship type has no stable ID: its records are not listed, since an aggregate stands for many and one member would pass for all. */
export const NO_STABLE_ID = 'no-stable-id';

/** One relationship that supports a derived edge: a stored one with its evidence, or an aggregate one that lists none. It carries no member count, time or property. */
export const derivedSupportSchema = z.union([
  z.strictObject({ ref: storedEdgeRefSchema, type: text, from: edgeEndSchema, to: edgeEndSchema, evidence: edgeEvidenceSchema }),
  z.strictObject({ ref: aggregateEdgeRefSchema, type: text, from: edgeEndSchema, to: edgeEndSchema, evidence: z.strictObject({ status: z.literal(NO_STABLE_ID) }) }),
]);

/** One chain of the rule through a distinct tuple of middle entities, in the order of the chain, with the relationships that support the derived edge along it. */
export const derivedSupportGroupSchema = z.strictObject({ middle: z.array(edgeEndSchema).min(1), supports: z.array(derivedSupportSchema).min(1) });

/** The supports of a derived edge: the chains the bounded read found, and their count. The count is of chains and is `exact` or `lowerBound`, never an estimate or unknown. */
export const derivedSupportsSchema = z.strictObject({
  count: countSchema,
  groups: z.array(derivedSupportGroupSchema).min(1),
});

/** What `GET /v1/edges/{ref}` answers for a derived edge: the rule with its version, both ends and the supports. There is no confidence or score field, and no element ID or URL. */
export const derivedEdgeDetailSchema = z
  .strictObject({
    ref: derivedEdgeRefSchema,
    type: text,
    semantics: z.literal('derived'),
    rule: z.strictObject({ id: text, version: z.number().int().min(1) }),
    from: edgeEndSchema,
    to: edgeEndSchema,
    supports: derivedSupportsSchema,
    qualityFlags: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .refine((detail) => (detail.supports.count.quality === 'exact' || detail.supports.count.quality === 'lowerBound') && detail.supports.count.value === detail.supports.groups.length, {
    message: 'the supports count is exact or a lower bound and equals the number of groups',
    path: ['supports', 'count'],
  });

/** The most members an aggregate answer samples; a source that lowered `max_page` lowers it. */
export const AGGREGATE_SAMPLE_SIZE = 25;

/** The scope of an aggregate's member count: every relationship of the type between the two ends, whatever filters a view applied. */
export const AGGREGATE_MEMBERS_SCOPE = 'aggregate:members';

/** `observed-newest`: the rows are newest first by observed time. `source-order`: the first members the source returned, in no order the product chose, which says nothing about time. */
export const AGGREGATE_SAMPLE_ORDERS = ['observed-newest', 'source-order'] as const;

/** One sampled member: its observed time and its mapped properties. It has no identifier, reference or link. */
export const aggregateSampleRowSchema = z.strictObject({ observedAt: text.optional(), properties: z.array(propertySchema) });

/** What `GET /v1/edges/{ref}` answers for an aggregate edge. The count is `exact` or `unknown` (no number, the first and last observed time and `more` then absent); the sample is bounded and never paged. */
export const aggregateEdgeDetailSchema = z
  .strictObject({
    ref: aggregateEdgeRefSchema,
    type: text,
    semantics: z.literal('aggregate'),
    from: edgeEndSchema,
    to: edgeEndSchema,
    members: countSchema,
    observedFirst: text.optional(),
    observedLast: text.optional(),
    sample: z.strictObject({ order: z.enum(AGGREGATE_SAMPLE_ORDERS), rows: z.array(aggregateSampleRowSchema).max(AGGREGATE_SAMPLE_SIZE), more: z.number().int().nonnegative().optional() }),
    qualityFlags: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .refine((detail) => detail.members.scope === AGGREGATE_MEMBERS_SCOPE && (detail.members.quality === 'exact' || detail.members.quality === 'unknown'), {
    message: 'the member count is exact or unknown and has the aggregate scope',
    path: ['members'],
  })
  .refine(
    (detail) =>
      detail.members.quality === 'exact'
        ? detail.members.value !== undefined && detail.sample.more === detail.members.value - detail.sample.rows.length
        : detail.sample.more === undefined && detail.observedFirst === undefined && detail.observedLast === undefined,
    { message: 'an exact count has more equal to the members not shown; an unknown count has no more and no observed range', path: ['sample', 'more'] },
  );

export const edgeDetailSchema = z.discriminatedUnion('semantics', [storedEdgeDetailSchema, derivedEdgeDetailSchema, aggregateEdgeDetailSchema]);

export type StoredEdgeDetail = z.infer<typeof storedEdgeDetailSchema>;
export type DerivedEdgeDetail = z.infer<typeof derivedEdgeDetailSchema>;
export type DerivedEdgeRef = z.infer<typeof derivedEdgeRefSchema>;
export type AggregateEdgeRef = z.infer<typeof aggregateEdgeRefSchema>;
export type AggregateEdgeDetail = z.infer<typeof aggregateEdgeDetailSchema>;
export type AggregateSampleRow = z.infer<typeof aggregateSampleRowSchema>;
export type DerivedSupport = z.infer<typeof derivedSupportSchema>;
export type DerivedSupportGroup = z.infer<typeof derivedSupportGroupSchema>;
/** A reference `GET /v1/edges/{ref}` answers: a stored, a derived or an aggregate one. */
export type EdgeReadRef = StoredEdgeRef | DerivedEdgeRef | AggregateEdgeRef;

export type EdgeEnd = z.infer<typeof edgeEndSchema>;
export type EdgeEvidenceRecord = z.infer<typeof edgeEvidenceRecordSchema>;
export type EdgeEvidence = z.infer<typeof edgeEvidenceSchema>;
export type EdgeDetail = z.infer<typeof edgeDetailSchema>;

/** The key order of the reference in the segment, so a client builds the same text for the same reference. */
const SEGMENT_KEYS = ['sourceId', 'type', 'from', 'to', 'stableId'] as const;

const orderedEnd = (ref: ElementRef): ElementRef => ({ sourceId: ref.sourceId, entityType: ref.entityType, stableId: ref.stableId });

/** The path segment of a stored, derived or aggregate edge reference: the unpadded base64url text of its JSON, the keys in a fixed order and no whitespace. The caller percent-encodes it for a URL. */
export function edgeRefSegmentOf(ref: EdgeReadRef): string {
  const ordered = 'derived' in ref
    ? { sourceId: ref.sourceId, derived: { ruleId: ref.derived.ruleId, from: orderedEnd(ref.derived.from), to: orderedEnd(ref.derived.to) } }
    : 'aggregate' in ref
      ? { sourceId: ref.sourceId, aggregate: { type: ref.aggregate.type, from: orderedEnd(ref.aggregate.from), to: orderedEnd(ref.aggregate.to) } }
      : Object.fromEntries(SEGMENT_KEYS.map((key) => [key, ref[key]]));
  return segmentOfJson(ordered);
}

/** The stored, derived or aggregate reference a segment holds, or undefined for anything else: text over the bound, a character outside the unpadded base64url alphabet, text that is not JSON, or JSON the reference schemas refuse. */
export function parseEdgeRefSegment(segment: string): EdgeReadRef | undefined {
  const json = jsonOfSegment(segment, MAX_EDGE_REF_SEGMENT);
  if (json === undefined) return undefined;
  const stored = storedEdgeRefSchema.safeParse(json);
  if (stored.success) return stored.data;
  const derived = derivedEdgeRefSchema.safeParse(json);
  if (derived.success) return derived.data;
  const aggregate = aggregateEdgeRefSchema.safeParse(json);
  return aggregate.success ? aggregate.data : undefined;
}

/** What the path of the route holds: the one segment, parsed by `parseEdgeRefSegment` in the route. */
export const edgePathSchema = z.strictObject({ ref: z.string().min(1).max(MAX_EDGE_REF_SEGMENT) });
