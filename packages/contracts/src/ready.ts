import { z } from 'zod';

export const databaseCheckSchema = z.enum(['ok', 'unreachable']);
export const migrationsCheckSchema = z.enum(['ok', 'pending', 'unknown']);

const count = z.number().int().nonnegative();

/** How many configured sources the last ping found reachable, unreachable, or has not yet said anything about. */
export const sourceReachabilitySchema = z.strictObject({ reachable: count, unreachable: count, unknown: count });

export const readyResponseSchema = z.strictObject({
  status: z.enum(['ready', 'not_ready']),
  checks: z.strictObject({ database: databaseCheckSchema, migrations: migrationsCheckSchema }),
  sources: sourceReachabilitySchema,
});

export type ReadyResponse = z.infer<typeof readyResponseSchema>;
export type ReadyChecks = ReadyResponse['checks'];
export type SourceReachability = ReadyResponse['sources'];
