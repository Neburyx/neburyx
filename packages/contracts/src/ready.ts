import { z } from 'zod';

export const databaseCheckSchema = z.enum(['ok', 'unreachable']);
export const migrationsCheckSchema = z.enum(['ok', 'pending', 'unknown']);

export const readyResponseSchema = z.strictObject({
  status: z.enum(['ready', 'not_ready']),
  checks: z.strictObject({ database: databaseCheckSchema, migrations: migrationsCheckSchema }),
});

export type ReadyResponse = z.infer<typeof readyResponseSchema>;
export type ReadyChecks = ReadyResponse['checks'];
