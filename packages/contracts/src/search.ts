import { z } from 'zod';
import { countSchema, nodeSchema } from './graph.js';

/** A stable ID can be one character, so an exact search takes one; the minimum of 2 belongs to type-ahead. */
export const MIN_SEARCH_TEXT_LENGTH = 1;
export const MAX_SEARCH_TEXT_LENGTH = 200;

/** The most hits a result group shows by default; a source whose `max_page` is lower shows that many, and a group that has more is a `lowerBound` count of the cap. */
export const SEARCH_GROUP_CAP = 25;

export const SEARCH_DISABLED_REASONS = ['index-unavailable'] as const;

const codePoints = (value: string): number => Array.from(value).length;

/** The typed text, counted as characters and not as UTF-16 units, which a length limit of the schema would count. */
export const searchTextSchema = z
  .string()
  .refine((value) => codePoints(value) >= MIN_SEARCH_TEXT_LENGTH && codePoints(value) <= MAX_SEARCH_TEXT_LENGTH, { message: 'search text is 1 to 200 characters' })
  .meta({ minLength: MIN_SEARCH_TEXT_LENGTH, maxLength: MAX_SEARCH_TEXT_LENGTH });

/** `POST /v1/search/entities`: one source, one text, optionally with the `pii` fields masked. */
export const searchRequestSchema = z.strictObject({ sourceId: z.string().min(1), text: searchTextSchema, mask: z.boolean().optional() });

const droppedCount = z.number().int().nonnegative();

/** The rows the normalize stage left out, by reason. */
export const droppedSchema = z.strictObject({ 'not-mapped': droppedCount, 'ambiguous-type': droppedCount, 'no-stable-id': droppedCount, 'not-visible': droppedCount.optional() });

export const disabledTypeSchema = z.strictObject({ entityType: z.string().min(1), reason: z.enum(SEARCH_DISABLED_REASONS) });

const exactCountSchema = countSchema.refine((count) => count.quality === 'exact' || count.quality === 'lowerBound', { message: 'the count of a result group is exact or a lower bound' });

export const searchResultSchema = z.strictObject({
  sourceId: z.string().min(1),
  exact: z.array(nodeSchema),
  /** The most hits the group shows for this source: 25, or the source's `max_page` when that is lower. */
  cap: z.number().int().positive(),
  /** False when no property was left to search (every type left out, or only personal-data properties while masked), so the answer is not a search that found nothing. */
  searchable: z.boolean(),
  counts: z.strictObject({ exact: exactCountSchema }),
  disabledTypes: z.array(disabledTypeSchema),
  dropped: droppedSchema,
  warnings: z.array(z.string()),
  elapsedMs: z.number().int().nonnegative(),
});

export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type DisabledType = z.infer<typeof disabledTypeSchema>;
