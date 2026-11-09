import { z } from 'zod';
import { elementRefSchema, propertySchema, storedEdgeRefSchema, type StoredEdgeRef } from './graph.js';

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
export const edgeDetailSchema = z.strictObject({
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

/** The path segment of a stored edge reference: the unpadded base64url text of its JSON, the keys in a fixed order and no whitespace. The caller percent-encodes it for a URL. */
export function edgeRefSegmentOf(ref: StoredEdgeRef): string {
  const ordered = Object.fromEntries(SEGMENT_KEYS.map((key) => [key, ref[key]]));
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(ordered)));
}

/** The stored reference a segment holds, or undefined for anything else: text over the bound, a character outside the unpadded base64url alphabet, text that is not JSON or JSON the reference schema refuses. */
export function parseEdgeRefSegment(segment: string): StoredEdgeRef | undefined {
  if (segment.length === 0 || segment.length > MAX_EDGE_REF_SEGMENT) return undefined;
  const bytes = base64UrlToBytes(segment);
  if (bytes === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  const parsed = storedEdgeRefSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** What the path of the route holds: the one segment, parsed by `parseEdgeRefSegment` in the route. */
export const edgePathSchema = z.strictObject({ ref: z.string().min(1).max(MAX_EDGE_REF_SEGMENT) });
