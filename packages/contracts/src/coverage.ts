import { z } from 'zod';
import { countSchema, elementRefSchema, type Count } from './graph.js';

const text = z.string().min(1);

/** The `scope` of every not-yet-retrieved count. */
export const COVERAGE_SCOPE = 'not yet retrieved';

/** The most loaded entities one coverage request names; a larger loaded graph is sent in chunks of this size. */
export const COVERAGE_MAX_ENTITIES = 500;

/** One loaded entity and how many stored relationships of it are loaded, counted once for each end that is at it (a self-loop counts 2). */
export const coverageEntitySchema = z.strictObject({ ref: elementRefSchema, storedRelationships: z.number().int().nonnegative() });

/** `POST /v1/graph/coverage`: the loaded entities of one source, whose degree previews the server already holds; `mask` is the setting those previews were asked under. */
export const coverageRequestSchema = z.strictObject({
  sourceId: text,
  entities: z.array(coverageEntitySchema).min(1).max(COVERAGE_MAX_ENTITIES),
  mask: z.boolean().optional(),
});

/** The relationships of the loaded entities that are not loaded, from previews already cached; `unknown`, with no value, when it cannot be told. */
export const coverageResponseSchema = z.strictObject({ notRetrieved: countSchema });

export type CoverageEntity = z.infer<typeof coverageEntitySchema>;
export type CoverageRequest = z.infer<typeof coverageRequestSchema>;
export type CoverageResponse = z.infer<typeof coverageResponseSchema>;

const UNKNOWN_COVERAGE: Count = { quality: 'unknown', scope: COVERAGE_SCOPE };

/**
 * Joins the answers for the chunks of one loaded graph. `exact` needs every chunk `exact` and at most one with anything left, since a relationship between entities of two chunks is in both. A `lowerBound`
 * chunk makes the result `lowerBound`, with the largest `exact` or `lowerBound` value as its floor, which may be below what one request over the whole graph would give; an `estimated` chunk is no floor.
 * An `unknown` chunk leaves the sum unknown, but that floor still holds, so the result is `lowerBound` when it is above 0 and `unknown` when not.
 */
export function combineCoverage(chunks: readonly Count[]): Count {
  if (chunks.length === 0) return UNKNOWN_COVERAGE;
  const floors = chunks.filter((chunk) => chunk.quality === 'exact' || chunk.quality === 'lowerBound').map((chunk) => chunk.value ?? 0);
  const floor = Math.max(0, ...floors);
  if (chunks.some((chunk) => chunk.value === undefined)) return floor > 0 ? { value: floor, quality: 'lowerBound', scope: COVERAGE_SCOPE } : UNKNOWN_COVERAGE;
  if (chunks.some((chunk) => chunk.quality === 'lowerBound')) return { value: floor, quality: 'lowerBound', scope: COVERAGE_SCOPE };
  const values = chunks.map((chunk) => chunk.value ?? 0);
  const sum = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(sum)) return UNKNOWN_COVERAGE;
  const weakened = values.filter((value) => value > 0).length > 1 || chunks.some((chunk) => chunk.quality === 'estimated');
  return { value: sum, quality: weakened ? 'estimated' : 'exact', scope: COVERAGE_SCOPE };
}
