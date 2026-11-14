import { z } from 'zod';
import { referenceTextSchema } from './entities.js';
import { countSchema, edgeSchema, elementRefSchema, nodeSchema } from './graph.js';
import { HEAVY_CONTINUE_LIMIT } from './template-run.js';

const text = z.string().min(1);

const endSchema = z.strictObject({ entityType: text, stableId: referenceTextSchema });

/**
 * `POST /v1/graph/paths`: the shortest paths between two entities of one source over the listed relationship types. The hop count and the result size are checked against the source's budget by the gate, which
 * answers `QUERY_BUDGET_EXCEEDED` for more than it allows. `mask` is the setting of the session.
 */
export const pathsRequestSchema = z.strictObject({
  sourceId: text,
  from: endSchema,
  to: endSchema,
  relTypes: z.array(text).min(1),
  maxHops: z.number().int().min(1),
  limit: z.number().int().min(1),
  direction: z.enum(['out', 'in', 'both']).optional(),
  /** Continue a search that stopped as heavy: no estimate is read and the result size is at most `HEAVY_CONTINUE_LIMIT`. */
  continue: z.boolean().optional(),
  mask: z.boolean().optional(),
});

/** One step of a path: the relationship's type, the entities it joins in the order the path is walked (the stored direction is the `from` and `to` of the matching edge), and the evidence references of the relationship. */
export const pathStepSchema = z.strictObject({ from: elementRefSchema, to: elementRefSchema, relationshipType: text, evidenceRefs: z.array(z.string()) });

export const pathSchema = z.strictObject({ hops: z.number().int().min(1), steps: z.array(pathStepSchema).min(1) });

/**
 * The paths of minimal length between the two ends, at most the limit, ordered by hops and then by the stable IDs of their steps, with the nodes and relationships the steps name. `capReached` means more paths of
 * minimal length exist than were returned.
 */
export const pathsOkSchema = z
  .strictObject({
  status: z.literal('ok'),
  paths: z.array(pathSchema),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  capReached: z.boolean(),
  /** True when the search timed out and these are the paths it had found; the result is not complete and `capReached` is then false. */
  partial: z.boolean(),
  /** For a partial answer: the paths kept and the result size asked for; equal when the limit was read before the time ran out. */
  retained: z.number().int().min(1).optional(),
  requested: z.number().int().min(1).optional(),
  elapsedMs: z.number().int().min(0),
  /** The estimate read before the search, `exact` or `lowerBound`; absent when the search was a continue. */
  estimate: countSchema.optional(),
  warnings: z.array(z.string()),
  })
  .refine((answer) => (answer.partial ? answer.retained !== undefined && answer.requested !== undefined : answer.retained === undefined && answer.requested === undefined), { message: 'a partial answer holds the counts of the paths kept and asked for, and no other answer holds them', path: ['partial'] })
  .refine((answer) => !answer.partial || !answer.capReached, { message: 'a partial answer never says the cap was reached', path: ['capReached'] });

/**
 * A search whose ends have more relationships to expand than the source's `heavy_op_threshold` stops with the estimate and no paths (TAS §8.1): the estimate is a lower bound at the threshold and `continueLimit` is the
 * result size a continue would use.
 */
export const pathsHeavySchema = z
  .strictObject({
    status: z.literal('heavy'),
    estimate: countSchema,
    threshold: z.number().int().min(1),
    continueLimit: z.number().int().min(1).max(HEAVY_CONTINUE_LIMIT),
    warnings: z.array(z.string()),
  })
  .refine((answer) => answer.estimate.quality === 'lowerBound' && answer.estimate.value === answer.threshold, { message: 'a heavy answer holds a lower bound at the threshold', path: ['estimate'] });

/** The answer of a search: the paths, or the stop of a heavy search; `status` tells them apart. */
export const pathsResponseSchema = z.union([pathsOkSchema, pathsHeavySchema]);

export type PathsRequest = z.infer<typeof pathsRequestSchema>;
export type PathStep = z.infer<typeof pathStepSchema>;
export type PathsOk = z.infer<typeof pathsOkSchema>;
export type PathsHeavy = z.infer<typeof pathsHeavySchema>;
export type PathsResponse = z.infer<typeof pathsResponseSchema>;
