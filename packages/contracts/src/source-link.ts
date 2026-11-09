import { z } from 'zod';
import { MAX_EDGE_REF_SEGMENT } from './edge-detail.js';
import { MAX_REFERENCE_VALUE_CHARACTERS, referenceTextSchema } from './entities.js';
import { storedEdgeRefSchema, type StoredEdgeRef } from './graph.js';
import { jsonOfSegment, segmentOfJson } from './ref-segment.js';

const entityLinkRefSchema = z.strictObject({ sourceId: z.string().min(1), entityType: z.string().min(1), stableId: referenceTextSchema });

export type EntityLinkRef = z.infer<typeof entityLinkRefSchema>;

/** What a `GET /v1/source-links/{ref}` segment names: an entity, or a stored edge whose record the `record` query names. */
export type SourceLinkRef = { readonly form: 'entity'; readonly ref: EntityLinkRef } | { readonly form: 'stored'; readonly ref: StoredEdgeRef };

const ENTITY_KEYS = ['sourceId', 'entityType', 'stableId'] as const;
const STORED_KEYS = ['sourceId', 'type', 'from', 'to', 'stableId'] as const;

/** The path segment of a link: the unpadded base64url text of the JSON of the reference, the keys in a fixed order. The caller percent-encodes it for a URL. */
export function sourceLinkSegmentOf(link: SourceLinkRef): string {
  const keys: readonly string[] = link.form === 'entity' ? ENTITY_KEYS : STORED_KEYS;
  const source: Readonly<Record<string, unknown>> = link.ref;
  return segmentOfJson(Object.fromEntries(keys.map((key) => [key, source[key]])));
}

/** The reference a segment holds, or undefined for anything else: text over the bound, text that is not base64url JSON, or JSON that is neither an entity reference nor a stored edge reference (an aggregate or derived reference is neither). */
export function parseSourceLinkSegment(segment: string): SourceLinkRef | undefined {
  const json = jsonOfSegment(segment, MAX_EDGE_REF_SEGMENT);
  if (json === undefined) return undefined;
  const stored = storedEdgeRefSchema.safeParse(json);
  if (stored.success) return { form: 'stored', ref: stored.data };
  const entity = entityLinkRefSchema.safeParse(json);
  return entity.success ? { form: 'entity', ref: entity.data } : undefined;
}

/** The path of `GET /v1/source-links/{ref}`: the one segment, parsed by `parseSourceLinkSegment` in the route. */
export const sourceLinkPathSchema = z.strictObject({ ref: z.string().min(1).max(MAX_EDGE_REF_SEGMENT) });

/** The query: `mask`, and for a stored edge the `record` to open. */
export const sourceLinkQuerySchema = z.strictObject({
  mask: z.enum(['true', 'false']).optional(),
  record: z.string().min(1).max(MAX_REFERENCE_VALUE_CHARACTERS).optional(),
});
