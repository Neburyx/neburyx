import { z } from 'zod';
import { referenceTextSchema } from './entities.js';
import { countSchema, edgeSchema, elementRefSchema, nodeSchema } from './graph.js';
import { HEAVY_CONTINUE_LIMIT, templateRunNoticeSchema } from './template-run.js';

const text = z.string().min(1);

/** The most steps a run reports a path for: the ceiling of a pattern. */
const MAX_PATH_STEPS = 4;

/**
 * `POST /v1/patterns/run`: the source, the definition (any object, so that a bad one is answered and not refused as a bad body; its shape is the pattern definition's, checked by the server), the entity the run starts from
 * (the same reference every route takes, of the definition's anchor type) and `mask`, which the nodes of the answer follow. `limit` is the page size; `continue` continues a run that stopped as heavy: it skips the estimate and
 * returns a first page of at most `HEAVY_CONTINUE_LIMIT`.
 */
export const patternRunRequestSchema = z.strictObject({
  sourceId: text,
  definition: z.record(z.string(), z.unknown()),
  anchor: z.strictObject({ entityType: text, stableId: referenceTextSchema }),
  limit: z.number().int().min(1).optional(),
  mask: z.boolean().optional(),
  continue: z.boolean().optional(),
});

/**
 * One hop of the path shown for a match: the type of the relationship (`null` when the relationship value was unusable), the entities it joins as stored (`null` for an end that has no usable stable ID, so the path keeps its
 * positions) and its stable ID when the mapping's row for it has one. The edge itself is in the answer's edges.
 */
export const patternHopSchema = z.strictObject({ relationshipType: text.nullable(), from: elementRefSchema.nullable(), to: elementRefSchema.nullable(), stableId: text.optional() });

/**
 * A match of a pattern run and the path shown to it: the number of steps, the entities between in order (`hops − 1`, with `null` where one has no usable stable ID: the client shows a gap, and the nodes of the answer are the
 * entities that are shown) and the relationship of each hop. A match reached by several paths shows one.
 */
export const patternMatchSchema = z
  .strictObject({
    match: elementRefSchema,
    hops: z.number().int().min(1).max(MAX_PATH_STEPS),
    through: z.array(elementRefSchema.nullable()),
    relationships: z.array(patternHopSchema),
  })
  .refine((entry) => entry.through.length === entry.hops - 1 && entry.relationships.length === entry.hops, { message: 'a path has one entity between each two hops and one relationship for each hop', path: ['hops'] });

export const patternRunOkSchema = z.strictObject({
  status: z.literal('ok'),
  templateVersion: text,
  count: countSchema,
  matches: z.array(patternMatchSchema),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  notices: z.array(templateRunNoticeSchema),
  warnings: z.array(z.string()),
});

/** A run that would match more than the source's threshold stops with the estimate and no rows, as a template run does: the estimate is a lower bound at the threshold, and `continueLimit` is the page a continue would use. */
export const patternRunHeavySchema = z
  .strictObject({
    status: z.literal('heavy'),
    templateVersion: text,
    estimate: countSchema,
    threshold: z.number().int().min(1),
    continueLimit: z.number().int().min(1).max(HEAVY_CONTINUE_LIMIT),
    notices: z.array(templateRunNoticeSchema),
    warnings: z.array(z.string()),
  })
  .refine((answer) => answer.estimate.quality === 'lowerBound' && answer.estimate.value === answer.threshold, { message: 'a heavy answer holds a lower bound at the threshold', path: ['estimate'] });

/** The answer of a pattern run: the result, or the stop of a heavy run; `status` tells them apart. */
export const patternRunResponseSchema = z.union([patternRunOkSchema, patternRunHeavySchema]);

export type PatternHop = z.infer<typeof patternHopSchema>;
export type PatternMatch = z.infer<typeof patternMatchSchema>;
export type PatternRunRequest = z.infer<typeof patternRunRequestSchema>;
export type PatternRunOk = z.infer<typeof patternRunOkSchema>;
export type PatternRunHeavy = z.infer<typeof patternRunHeavySchema>;
export type PatternRunResponse = z.infer<typeof patternRunResponseSchema>;
