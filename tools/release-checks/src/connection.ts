import { DEV_ENV_FILE, DevNeo4jNotConfigured, devSettings } from '@neburyx/test-neo4j';

export type Connection = { readonly ok: true; readonly secrets: readonly string[]; readonly login: string } | { readonly ok: false; readonly detail: string };

/** Whether the Neo4j connection of the tests is given, in the environment or in the settings file; never carries a value except in `secrets` and `login`. */
export function neo4jConnection(env: Readonly<Record<string, string | undefined>>, settingsFile: string = DEV_ENV_FILE): Connection {
  try {
    const settings = devSettings(env, settingsFile);
    return { ok: true, secrets: [settings.uri, settings.password], login: settings.user };
  } catch (error) {
    if (error instanceof DevNeo4jNotConfigured) return { ok: false, detail: `Neo4j connection not set: ${error.missing.join(', ')}` };
    return { ok: false, detail: `Neo4j connection refused: ${error instanceof Error ? error.message : 'unknown error'}` };
  }
}
