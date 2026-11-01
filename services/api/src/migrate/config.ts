import { z } from 'zod';
import { ConfigError } from '../config.js';

const MIGRATION_URL_KEY = 'DATABASE_MIGRATION_URL';
const APP_ROLE_KEY = 'DATABASE_APP_ROLE';

const databaseUrlSchema = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === 'postgres:' || protocol === 'postgresql:';
    } catch {
      return false;
    }
  });

export interface MigrateConfig {
  readonly url: string;
  readonly appRole: string;
}

export function parseMigrateConfig(env: Readonly<Record<string, string | undefined>>): MigrateConfig {
  const url = databaseUrlSchema.safeParse(env[MIGRATION_URL_KEY]);
  const appRole = z.string().min(1).safeParse(env[APP_ROLE_KEY]);
  const failed = [...(url.success ? [] : [MIGRATION_URL_KEY]), ...(appRole.success ? [] : [APP_ROLE_KEY])];
  if (!url.success || !appRole.success) throw new ConfigError(failed);
  return { url: url.data, appRole: appRole.data };
}
