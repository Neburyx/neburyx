const PASS_THROUGH = ['PATH', 'HOME', 'TMPDIR', 'NODE_ENV', 'LANG'] as const;

type Source = Readonly<Record<string, string | undefined>>;
export type Environment = Readonly<Record<string, string>>;

function pick(source: Source, names: readonly string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) picked[name] = value;
  }
  return picked;
}

export function baseEnvironment(source: Source): Environment {
  return pick(source, PASS_THROUGH);
}

export function migrationEnvironment(base: Environment, migrationUrl: string, appRole: string): Environment {
  return { ...base, DATABASE_MIGRATION_URL: migrationUrl, DATABASE_APP_ROLE: appRole };
}

export interface ApiSettings {
  readonly databaseUrl: string;
  readonly mappingPath: string;
  readonly port: number;
  readonly webRoot: string;
  /** Base64 of 32 random bytes, made once per run so cursors survive the API's restarts. */
  readonly cursorKey: string;
  /** A directory of the developer's own for export files, so a run never needs the image's `/data/exports`. */
  readonly exportDirectory: string;
  /** The logins the mapping's sources name: the values of the developer's own env file. */
  readonly sourceLogins: Environment;
}

/** The API holds the app role's URL and the source logins, never the administrator or the migration password. The fixed values come last, so no login can replace one. */
export function apiEnvironment(base: Environment, api: ApiSettings): Environment {
  return {
    ...base,
    ...api.sourceLogins,
    DATABASE_URL: api.databaseUrl,
    NEBURYX_CONFIG: api.mappingPath,
    NEBURYX_HOST: '127.0.0.1',
    NEBURYX_PORT: String(api.port),
    NEBURYX_WEB_ROOT: api.webRoot,
    NEBURYX_CURSOR_KEY: api.cursorKey,
    NEBURYX_EXPORT_DIR: api.exportDirectory,
  };
}

export function webEnvironment(base: Environment, apiUrl: string): Environment {
  return { ...base, NEBURYX_DEV_API_URL: apiUrl };
}
