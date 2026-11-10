import { z } from 'zod';
import { aggregateEdgeRefSchema, derivedEdgeRefSchema } from './edge-detail.js';
import { edgeRefSchema, edgeSchema, elementRefSchema, nodeSchema, storedEdgeRefSchema } from './graph.js';

const text = z.string().min(1);

/** The most references of one kind a read by references takes: the limit of a list parameter of a template (`docs/api-conventions.md`). */
export const MAX_READ_REFS = 100;

const listOf = <S extends z.ZodType>(schema: S) => z.array(schema).max(MAX_READ_REFS).default([]);

/**
 * `POST /v1/graph/read-refs`: the items of one source that a stored draft names, read again as the person sees them now. A stored draft holds references, never property values, so this is how a reopened
 * investigation gets its entities and relationships back, in calls of at most `MAX_READ_REFS` references of each kind. `mask` is the setting of the session.
 */
export const readRefsRequestSchema = z.strictObject({
  sourceId: text,
  mask: z.boolean().optional(),
  entities: listOf(elementRefSchema),
  edges: listOf(storedEdgeRefSchema),
  aggregates: listOf(aggregateEdgeRefSchema),
  derived: listOf(derivedEdgeRefSchema),
});

/** What no longer resolves is listed once, whatever the cause: gone from the source, a type or rule no longer mapped, or not readable by the person. Nothing says which. */
export const readRefsResponseSchema = z.strictObject({
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  missing: z.strictObject({ entities: z.array(elementRefSchema), edges: z.array(edgeRefSchema) }),
});

export type ReadRefsRequest = z.infer<typeof readRefsRequestSchema>;
export type ReadRefsResponse = z.infer<typeof readRefsResponseSchema>;
