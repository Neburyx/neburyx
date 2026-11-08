import { isAbsolute, join } from 'node:path';
import type { Files } from './files.js';
import { parseEnvFile } from './settings.js';

export const CONFIG_KEYS = ['NEBURYX_DEV_MAPPING', 'NEBURYX_DEV_MAPPING_ENV', 'NEBURYX_DEV_DATABASE_URL', 'NEBURYX_DEV_DATABASE_MIGRATION_URL', 'NEBURYX_DEV_DATABASE_APP_ROLE'] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];
export type DevConfig = Readonly<Record<ConfigKey, string>>;

export const CONFIG_VARIABLE = 'NEBURYX_DEV_CONFIG';
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_PATH = ['.config', 'neburyx', 'dev.env'] as const;

export class ConfigUnusable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigUnusable';
  }
}

export function configPath(env: Readonly<Record<string, string | undefined>>): string {
  const named = env[CONFIG_VARIABLE] ?? '';
  if (named !== '') {
    if (!isAbsolute(named)) throw new ConfigUnusable(`${CONFIG_VARIABLE} must be an absolute path`);
    return named;
  }
  const home = env['HOME'] ?? '';
  if (home === '' || !isAbsolute(home)) throw new ConfigUnusable(`there is no settings file to read: ${CONFIG_VARIABLE} is not set and HOME is not an absolute path`);
  return join(home, ...DEFAULT_PATH);
}

/**
 * The five settings of `pnpm dev`: the file named by NEBURYX_DEV_CONFIG, or ~/.config/neburyx/dev.env; a non-empty value in the
 * environment wins over the file's. The file must exist and be readable by its owner only. Every message names the file's path
 * or a setting's name and never a value read from the file or the environment.
 */
export function loadDevConfig(env: Readonly<Record<string, string | undefined>>, files: Files): DevConfig {
  const path = configPath(env);
  if (!files.exists(path)) throw new ConfigUnusable(`the settings file ${path} does not exist; pnpm dev reads ${CONFIG_KEYS.join(', ')} from it and starts nothing without it`);
  const mode = files.mode(path);
  if ((mode & ~0o600) !== 0) throw new ConfigUnusable(`the settings file ${path} has mode 0${mode.toString(8)}, wider than 0600; run chmod 600 on it`);
  const fromFile = parseEnvFile(files.read(path));
  const unknown = [...fromFile.keys()].filter((name) => !(CONFIG_KEYS as readonly string[]).includes(name));
  if (unknown.length > 0) {
    // A stray line such as a connection string parses with a "name" that holds its text, so only a real variable name is shown.
    const named = unknown.filter((name) => VARIABLE_NAME.test(name));
    const stray = unknown.length - named.length;
    const parts = [...(named.length > 0 ? [named.join(', ')] : []), ...(stray > 0 ? [`${stray} line${stray === 1 ? '' : 's'} that ${stray === 1 ? 'is' : 'are'} not NAME=value`] : [])];
    throw new ConfigUnusable(`the settings file ${path} holds settings pnpm dev does not know: ${parts.join(' and ')}`);
  }

  const values: Partial<Record<ConfigKey, string>> = {};
  const missing: ConfigKey[] = [];
  for (const key of CONFIG_KEYS) {
    const value = (env[key] ?? '') !== '' ? env[key] : fromFile.get(key);
    if (value === undefined || value === '') missing.push(key);
    else values[key] = value;
  }
  if (missing.length > 0) throw new ConfigUnusable(`the settings are incomplete: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} neither in ${path} nor in the environment`);
  return values as DevConfig;
}
