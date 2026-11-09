import { z } from 'zod';
import { referenceTextSchema } from './entities.js';
import { countSchema, edgeSchema, nodeSchema } from './graph.js';

const text = z.string().min(1);

/** The most other ends one run of a derived rule finds and returns: the read asks for one more to learn that it was cut. A source that lowered `max_page` lowers it to that; a larger `max_page` does not raise it. */
export const DERIVED_NEIGHBOR_CAP = 25;

/** `POST /v1/graph/derived-neighbors`: the entity of one source whose rule-derived neighbors are asked for; `mask` is carried because the nodes of the answer follow it. */
export const derivedNeighborsRequestSchema = z.strictObject({
  sourceId: text,
  ref: z.strictObject({ entityType: text, stableId: referenceTextSchema }),
  mask: z.boolean().optional(),
});

/** The run of one rule: its count, and the other ends, the middle entities, the derived edges and the supporting edges of the derived edges that were counted. */
export const derivedNeighborsResultSchema = z.strictObject({
  ruleId: text,
  ruleVersion: z.number().int().min(1),
  count: countSchema,
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  warnings: z.array(z.string()),
});

export const derivedNeighborsResponseSchema = z.strictObject({
  ref: z.strictObject({ sourceId: text, entityType: text, stableId: referenceTextSchema }),
  results: z.array(derivedNeighborsResultSchema),
});

export type DerivedNeighborsRequest = z.infer<typeof derivedNeighborsRequestSchema>;
export type DerivedNeighborsResult = z.infer<typeof derivedNeighborsResultSchema>;
export type DerivedNeighborsResponse = z.infer<typeof derivedNeighborsResponseSchema>;
