export const EXTERNAL_VARIABLES = ['NEBURYX_DEV_DATABASE_URL', 'NEBURYX_DEV_DATABASE_MIGRATION_URL', 'NEBURYX_DEV_DATABASE_APP_ROLE'] as const;

export interface ExternalDatabase {
  readonly appUrl: string;
  readonly migrationUrl: string;
  readonly appRole: string;
}

export class IncompleteExternalDatabase extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`the external database needs all of ${EXTERNAL_VARIABLES.join(', ')}; missing: ${missing.join(', ')}`);
    this.name = 'IncompleteExternalDatabase';
    this.missing = missing;
  }
}

export function externalDatabase(env: Readonly<Record<string, string | undefined>>): ExternalDatabase | undefined {
  const [appUrl, migrationUrl, appRole] = EXTERNAL_VARIABLES.map((name) => env[name]);
  const present = [appUrl, migrationUrl, appRole].filter((value) => value !== undefined && value !== '');
  if (present.length === 0) return undefined;
  const missing = EXTERNAL_VARIABLES.filter((name) => (env[name] ?? '') === '');
  if (missing.length > 0 || appUrl === undefined || migrationUrl === undefined || appRole === undefined) throw new IncompleteExternalDatabase(missing);
  return { appUrl, migrationUrl, appRole };
}
