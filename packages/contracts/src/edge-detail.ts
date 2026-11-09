import { z } from 'zod';
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

export const edgeDetailSchema = z.discriminatedUnion('semantics', [storedEdgeDetailSchema, derivedEdgeDetailSchema]);

export type StoredEdgeDetail = z.infer<typeof storedEdgeDetailSchema>;
export type DerivedEdgeDetail = z.infer<typeof derivedEdgeDetailSchema>;
export type DerivedEdgeRef = z.infer<typeof derivedEdgeRefSchema>;
export type DerivedSupport = z.infer<typeof derivedSupportSchema>;
export type DerivedSupportGroup = z.infer<typeof derivedSupportGroupSchema>;
/** A reference `GET /v1/edges/{ref}` answers: a stored or a derived one. */
export type EdgeReadRef = StoredEdgeRef | DerivedEdgeRef;

export type EdgeEnd = z.infer<typeof edgeEndSchema>;
export type EdgeEvidenceRecord = z.infer<typeof edgeEvidenceRecordSchema>;
export type EdgeEvidence = z.infer<typeof edgeEvidenceSchema>;
export type EdgeDetail = z.infer<typeof edgeDetailSchema>;

/** The key order of the reference in the segment, so a client builds the same text for the same reference. */
const SEGMENT_KEYS = ['sourceId', 'type', 'from', 'to', 'stableId'] as const;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlToBytes(value: string): Uint8Array | undefined {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return undefined;
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

const orderedEnd = (ref: ElementRef): ElementRef => ({ sourceId: ref.sourceId, entityType: ref.entityType, stableId: ref.stableId });

/** The path segment of a stored or derived edge reference: the unpadded base64url text of its JSON, the keys in a fixed order and no whitespace. The caller percent-encodes it for a URL. */
export function edgeRefSegmentOf(ref: EdgeReadRef): string {
  const ordered = 'derived' in ref
    ? { sourceId: ref.sourceId, derived: { ruleId: ref.derived.ruleId, from: orderedEnd(ref.derived.from), to: orderedEnd(ref.derived.to) } }
    : Object.fromEntries(SEGMENT_KEYS.map((key) => [key, ref[key]]));
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(ordered)));
}

/** The stored or derived reference a segment holds, or undefined for anything else: text over the bound, a character outside the unpadded base64url alphabet, text that is not JSON, an aggregate reference or JSON the reference schemas refuse. */
export function parseEdgeRefSegment(segment: string): EdgeReadRef | undefined {
  if (segment.length === 0 || segment.length > MAX_EDGE_REF_SEGMENT) return undefined;
  const bytes = base64UrlToBytes(segment);
  if (bytes === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  const stored = storedEdgeRefSchema.safeParse(json);
  if (stored.success) return stored.data;
  const derived = derivedEdgeRefSchema.safeParse(json);
  return derived.success ? derived.data : undefined;
}

/** What the path of the route holds: the one segment, parsed by `parseEdgeRefSegment` in the route. */
export const edgePathSchema = z.strictObject({ ref: z.string().min(1).max(MAX_EDGE_REF_SEGMENT) });
