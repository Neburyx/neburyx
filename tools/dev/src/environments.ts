import type { Settings } from './settings.js';

const PASS_THROUGH = ['PATH', 'HOME', 'TMPDIR', 'NODE_ENV', 'LANG'] as const;
const DOCKER_SETTINGS = ['DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'XDG_CONFIG_HOME'] as const;

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

export function dockerEnvironment(source: Source): Environment {
  return { ...baseEnvironment(source), ...pick(source, DOCKER_SETTINGS) };
}

export function migrationEnvironment(base: Environment, migrationUrl: string, appRole: string): Environment {
  return { ...base, DATABASE_MIGRATION_URL: migrationUrl, DATABASE_APP_ROLE: appRole };
}

export interface ApiSettings {
  readonly databaseUrl: string;
  readonly mappingPath: string;
  readonly port: number;
  readonly webRoot: string;
  readonly settings: Settings;
}

/** The API holds the app role's URL and the demo login, never the administrator or the migration password. */
export function apiEnvironment(base: Environment, api: ApiSettings): Environment {
  return {
    ...base,
    DATABASE_URL: api.databaseUrl,
    NEBURYX_CONFIG: api.mappingPath,
    NEBURYX_HOST: '127.0.0.1',
    NEBURYX_PORT: String(api.port),
    NEBURYX_WEB_ROOT: api.webRoot,
    NEBURYX_CURSOR_KEY: api.settings.NEBURYX_CURSOR_KEY,
    DEMO_NEO4J_USER: 'neo4j',
    DEMO_NEO4J_PASSWORD: api.settings.DEMO_NEO4J_PASSWORD,
  };
}

export function webEnvironment(base: Environment, apiUrl: string): Environment {
  return { ...base, NEBURYX_DEV_API_URL: apiUrl };
}
