import type { DevConfig } from './config.js';

export interface ExternalDatabase {
  readonly appUrl: string;
  readonly migrationUrl: string;
  readonly appRole: string;
}

export function externalDatabase(config: DevConfig): ExternalDatabase {
  return { appUrl: config.NEBURYX_DEV_DATABASE_URL, migrationUrl: config.NEBURYX_DEV_DATABASE_MIGRATION_URL, appRole: config.NEBURYX_DEV_DATABASE_APP_ROLE };
}
