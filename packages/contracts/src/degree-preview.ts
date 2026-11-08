import { z } from 'zod';
import { countSchema, elementRefSchema } from './graph.js';
import { referenceTextSchema } from './entities.js';

const text = z.string().min(1);

/** `POST /v1/graph/preview-expansion`: the node of one source whose degree is asked for; `mask` is carried because a preview is cached per mask setting. */
export const degreePreviewRequestSchema = z.strictObject({
  sourceId: text,
  ref: z.strictObject({ entityType: text, stableId: referenceTextSchema }),
  mask: z.boolean().optional(),
});

export const DEGREE_DIRECTIONS = ['out', 'in'] as const;

export const DEGREE_WARNING_CODES = ['counts-capped', 'duplicate-stable-id'] as const;

export const degreeWarningSchema = z.strictObject({ code: z.enum(DEGREE_WARNING_CODES), relationshipType: text.optional(), reason: text });

/** The count of the mapped relationships of one type that leave (`out`) or enter (`in`) the node, and the entity types at their other ends. */
export const degreeByTypeSchema = z.strictObject({ relationshipType: text, direction: z.enum(DEGREE_DIRECTIONS), count: countSchema, neighborTypes: z.array(text).min(1) });

export const degreeByNeighborTypeSchema = z.strictObject({ entityType: text, count: countSchema });

export const degreePreviewSchema = z.strictObject({
  ref: elementRefSchema,
  total: countSchema,
  byType: z.array(degreeByTypeSchema),
  byNeighborType: z.array(degreeByNeighborTypeSchema),
  warnings: z.array(degreeWarningSchema),
  /** The number of relationships an expansion loads for each type when the request names no page size: the source's default page. */
  pageSize: z.number().int().positive(),
  /** The source's `heavy_op_threshold`: an expansion estimated above it is warned about before it is sent (the warning never refuses). */
  heavyOpThreshold: z.number().int().positive(),
});

export type DegreePreviewRequest = z.infer<typeof degreePreviewRequestSchema>;
export type DegreePreview = z.infer<typeof degreePreviewSchema>;
export type DegreeByType = z.infer<typeof degreeByTypeSchema>;
export type DegreeWarning = z.infer<typeof degreeWarningSchema>;
