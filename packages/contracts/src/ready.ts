import { z } from 'zod';

export const databaseCheckSchema = z.enum(['ok', 'unreachable']);
export const migrationsCheckSchema = z.enum(['ok', 'pending', 'unknown']);

const count = z.number().int().nonnegative();

/** How many configured sources the last ping found reachable, unreachable, or has not yet said anything about. */
export const sourceReachabilitySchema = z.strictObject({ reachable: count, unreachable: count, unknown: count });

/** What this process's audit writers have done since it started: events written, failed after their retries, dropped, and waiting now. They are counters of this process and never decide readiness. */
export const auditCountsSchema = z.strictObject({ written: count, failed: count, dropped: count, queued: count });

export const readyResponseSchema = z.strictObject({
  status: z.enum(['ready', 'not_ready']),
  checks: z.strictObject({ database: databaseCheckSchema, migrations: migrationsCheckSchema }),
  sources: sourceReachabilitySchema,
  audit: auditCountsSchema,
});

export type ReadyResponse = z.infer<typeof readyResponseSchema>;
export type ReadyChecks = ReadyResponse['checks'];
export type SourceReachability = ReadyResponse['sources'];
export type AuditCounts = ReadyResponse['audit'];
