/** The start-up variable that, with `ai.preview: true` in the mapping, switches the enterprise path on; only the migrate step and the API are given it. */
export const PROFILE_VARIABLE = 'NEBURYX_PROFILE';

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

/** With the profile set, the migrate step also reads the mapping, to decide the switch and apply the migrations of the enterprise path; with none it is as it was. */
export function migrationEnvironment(base: Environment, migrationUrl: string, appRole: string, preview?: { readonly profile: string; readonly mappingPath: string }): Environment {
  return { ...base, DATABASE_MIGRATION_URL: migrationUrl, DATABASE_APP_ROLE: appRole, ...(preview === undefined ? {} : { [PROFILE_VARIABLE]: preview.profile, NEBURYX_CONFIG: preview.mappingPath }) };
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
  /** The value of `NEBURYX_PROFILE` in the developer's shell, when it is set and not empty. */
  readonly profile?: string | undefined;
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
    ...(api.profile === undefined ? {} : { [PROFILE_VARIABLE]: api.profile }),
  };
}

export function webEnvironment(base: Environment, apiUrl: string): Environment {
  return { ...base, NEBURYX_DEV_API_URL: apiUrl };
}
