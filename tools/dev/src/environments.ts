/** The start-up variable that, with `ai.preview: true` in the mapping, switches the enterprise path on; only the migrate step and the API are given it. */
export const PROFILE_VARIABLE = 'NEBURYX_PROFILE';

const PASS_THROUGH = ['PATH', 'HOME', 'TMPDIR', 'NODE_ENV', 'LANG'] as const;

const CONNECT_LIMIT_VARIABLE = 'NEBURYX_DATABASE_CONNECT_TIMEOUT_MS';
const READINESS_LIMIT_VARIABLE = 'NEBURYX_READINESS_LIMIT_MS';
const LIMIT_VARIABLES = [CONNECT_LIMIT_VARIABLE, READINESS_LIMIT_VARIABLE] as const;
/** The API's own default, `CONNECTION_TIMEOUT_MS` in `services/api/src/db/pool.ts`; a workspace check keeps the two equal. */
export const DEFAULT_CONNECT_LIMIT_MS = 10_000;

const DEV_VARIABLE = 'NEBURYX_DEV';

const CACHE_VARIABLES = ['NEBURYX_AI_CACHE', 'NEBURYX_AI_CACHE_TTL'] as const;

const ASK_VARIABLES = [
  'NEBURYX_ASK_PROVIDER',
  'NEBURYX_ASK_CLASSIFICATION_MODEL',
  'NEBURYX_ASK_API_KEY',
  'NEBURYX_ASK_API_KEY_FILE',
  'NEBURYX_ASK_MAPPING_FOLDER',
  'NEBURYX_ASK_EFFORT',
  'NEBURYX_ASK_TIMEOUT_MS',
  'NEBURYX_ASK_MAX_RETRIES',
  'NEBURYX_ASK_MAX_TOKENS',
] as const;

/** What decides whether the AI extension is loaded besides the mapping: the key (or its file) and the three on/off settings. The migrate step and the API both read them, so that both reach the same decision. */
const AI_DECISION_VARIABLES = ['NEBURYX_ASK_API_KEY', 'NEBURYX_ASK_API_KEY_FILE', 'NEBURYX_ASK_ENABLED', 'NEBURYX_SUMMARY_ENABLED', 'NEBURYX_ASSISTANT_ENABLED'] as const;

const SUMMARY_VARIABLES = [
  'NEBURYX_SUMMARY_MODEL',
  'NEBURYX_SUMMARY_TOKEN_KEY_FILE',
  'NEBURYX_SUMMARY_TOKEN_KEY_PREVIOUS_FILE',
  'NEBURYX_SUMMARY_PROMPT_FILE',
  'NEBURYX_SUMMARY_TYPOLOGY_FILE',
  'NEBURYX_SUMMARY_MAX_ELEMENTS',
  'NEBURYX_SUMMARY_MAX_INPUT_TOKENS',
  'NEBURYX_SUMMARY_MAX_OUTPUT_TOKENS',
  'NEBURYX_SUMMARY_MAX_CALLS',
  'NEBURYX_SUMMARY_TIMEOUT_MS',
  'NEBURYX_SUMMARY_TOTAL_TIMEOUT_MS',
  'NEBURYX_SUMMARY_RUN_RETENTION_DAYS',
] as const;

/** The settings of the assistant the developer may set; only the API reads them (its on/off switch is one of the AI decision settings). */
const ASSISTANT_VARIABLES = [
  'NEBURYX_ASSISTANT_MODEL',
  'NEBURYX_ASSISTANT_PROMPT_FILE',
  'NEBURYX_ASSISTANT_VIEW_PROMPT_FILE',
  'NEBURYX_ASSISTANT_TYPOLOGY_FILE',
  'NEBURYX_ASSISTANT_CONTEXT_TURNS',
  'NEBURYX_ASSISTANT_MAX_CALLS',
  'NEBURYX_ASSISTANT_MAX_STEPS',
  'NEBURYX_ASSISTANT_MAX_ROWS',
  'NEBURYX_ASSISTANT_MAX_INPUT_TOKENS',
  'NEBURYX_ASSISTANT_MAX_OUTPUT_TOKENS',
  'NEBURYX_ASSISTANT_MAX_MESSAGE_WORDS',
  'NEBURYX_ASSISTANT_TIMEOUT_MS',
  'NEBURYX_ASSISTANT_TOTAL_TIMEOUT_MS',
  'NEBURYX_ASSISTANT_RUN_RETENTION_DAYS',
  'NEBURYX_ASSISTANT_THREAD_READ_TURNS',
  'NEBURYX_ASSISTANT_THREAD_RETENTION',
] as const;

/** Every setting the AI settings file of `pnpm dev:enterprise` may hold: the ones `pnpm dev` already takes from the shell for the AI features, and nothing else. */
export const AI_FILE_VARIABLES: readonly string[] = [...new Set([PROFILE_VARIABLE, DEV_VARIABLE, ...CACHE_VARIABLES, ...ASK_VARIABLES, ...AI_DECISION_VARIABLES, ...SUMMARY_VARIABLES, ...ASSISTANT_VARIABLES])];

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

/** The two limits on the application database that the developer may set; only the migrate step and the API are given them. */
export function limitsEnvironment(source: Source): Environment {
  return pick(source, LIMIT_VARIABLES);
}

/** The dev switch of the API: `NEBURYX_DEV` in the developer's shell is passed to the API (it reads the mapping file again when it is saved); only the API reads it. */
export function devEnvironment(source: Source): Environment {
  return pick(source, [DEV_VARIABLE]);
}

/** The two prompt-cache settings the developer may set; only the API reads them, so the migrate step and the web server are not given them. */
export function cacheEnvironment(source: Source): Environment {
  return pick(source, CACHE_VARIABLES);
}

/** The settings of Ask the developer may set in the shell; only the API reads them, so the migrate step and the web server are not given them, and the mapping's env file never carries them. */
export function askEnvironment(source: Source): Environment {
  return { ...pick(source, ASK_VARIABLES), ...aiDecisionEnvironment(source) };
}

export function aiDecisionEnvironment(source: Source): Environment {
  return pick(source, AI_DECISION_VARIABLES);
}

/** The settings of the case summary the developer may set in the shell; only the API reads them, so the migrate step and the web server are not given them. */
export function summaryEnvironment(source: Source): Environment {
  return pick(source, SUMMARY_VARIABLES);
}

/** The settings of the assistant the developer may set; only the API reads them. */
export function assistantEnvironment(source: Source): Environment {
  return pick(source, ASSISTANT_VARIABLES);
}

/** The connect limit the children will use, for the wait that must outlast it; a value they would refuse counts as the default, since they stop on it themselves. */
export function connectLimitMs(source: Source): number {
  const value = source[CONNECT_LIMIT_VARIABLE];
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : DEFAULT_CONNECT_LIMIT_MS;
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
