import { z } from 'zod';
import { patternRunResponseSchema } from './pattern-run.js';
import { referenceTextSchema } from './entities.js';
import { patternUnavailableReasonSchema } from './saved-pattern.js';
import { MAX_PATTERN_PROBLEMS } from './pattern.js';
import { templateRunResponseSchema } from './template-run.js';

/**
 * `POST /v1/patterns/{id}/run`: the pattern is the one in the path, so the body has no source and no definition. `anchor` is the starting entity for this run and replaces the one the pattern holds; a pattern that holds none needs it.
 * `limit`, `mask` and `continue` are those of the run route (`continue` continues a run that stopped as heavy: it skips the estimate and returns a first page of at most `HEAVY_CONTINUE_LIMIT`).
 */
export const savedPatternRunRequestSchema = z.strictObject({
  anchor: z.strictObject({ entityType: z.string().min(1), stableId: referenceTextSchema }).optional(),
  limit: z.number().int().min(1).optional(),
  mask: z.boolean().optional(),
  continue: z.boolean().optional(),
});

/** The answer of a run of a pattern that can no longer run against the current mapping: no source was read. */
export const patternUnavailableSchema = z.strictObject({ status: z.literal('unavailable'), reasons: z.array(patternUnavailableReasonSchema).min(1).max(MAX_PATTERN_PROBLEMS) });

/**
 * The answer of a saved run: what the same run returns through its own route (a pattern answer, with `matches`, for a pattern built in the app; a template answer, with `matchIds`, for a saved run of a preset), or that the
 * pattern is unavailable. The kind of the saved pattern the client holds says which of the first two to expect.
 */
export const savedPatternRunResponseSchema = z.union([patternRunResponseSchema, templateRunResponseSchema, patternUnavailableSchema]);

export type SavedPatternRunRequest = z.infer<typeof savedPatternRunRequestSchema>;
export type PatternUnavailable = z.infer<typeof patternUnavailableSchema>;
export type SavedPatternRunResponse = z.infer<typeof savedPatternRunResponseSchema>;
