import { z } from 'zod';
import { referenceTextSchema } from './entities.js';
import { countSchema, edgeSchema, nodeSchema } from './graph.js';

const text = z.string().min(1);

export const EXPAND_DIRECTIONS = ['out', 'in', 'both'] as const;

/** The one order of a page: the `observed_at` of the relationship's mapping row, newest first, undated last. */
export const EXPAND_SORTS = ['observed'] as const;

/**
 * `POST /v1/graph/expand`: one page of the neighbors of one entity for each asked neighbor type. `limit` is the page size of every type (the source's default when absent); `cursors` holds
 * the `nextCursor` of an earlier page for the types that continue. `mask` is carried because the answer follows the masking setting.
 */
export const expandRequestSchema = z.strictObject({
  sourceId: text,
  ref: z.strictObject({ entityType: text, stableId: referenceTextSchema }),
  relTypes: z.array(text).min(1).optional(),
  neighborTypes: z.array(text).min(1),
  direction: z.enum(EXPAND_DIRECTIONS).optional(),
  sort: z.enum(EXPAND_SORTS).optional(),
  limit: z.number().int().optional(),
  cursors: z.record(text, text).optional(),
  mask: z.boolean().optional(),
});

/** The page of one neighbor type: how many relationships it holds, whether there is more, and where the next page starts. `matchingTotal` has a value only when the first page holds everything. */
export const expandPageSchema = z.strictObject({
  neighborType: text,
  returned: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  matchingTotal: countSchema,
  nextCursor: text.optional(),
});

export const expandResponseSchema = z.strictObject({
  ref: z.strictObject({ sourceId: text, entityType: text, stableId: referenceTextSchema }),
  pageSize: z.number().int().positive(),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  pages: z.array(expandPageSchema),
  warnings: z.array(z.string()),
});

export type ExpandRequest = z.infer<typeof expandRequestSchema>;
export type ExpandPage = z.infer<typeof expandPageSchema>;
export type ExpandResponse = z.infer<typeof expandResponseSchema>;
