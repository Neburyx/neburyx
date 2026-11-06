import { isAbsolute } from 'node:path';
import type { Environment } from './environments.js';
import { EXTERNAL_VARIABLES } from './external.js';
import { parseEnvFile } from './settings.js';

export const MAPPING_VARIABLES = ['NEBURYX_DEV_MAPPING', 'NEBURYX_DEV_MAPPING_ENV'] as const;

/** Names the tool sets itself for the API, or that change how a program starts; a login file never supplies them. */
const RESERVED = /^(PATH|HOME|TMPDIR|LANG|NODE_.*|DATABASE_.*|NEBURYX_.*|DEMO_NEO4J_.*)$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface DevMapping {
  readonly mappingPath: string;
  readonly logins: Environment;
}

export interface MappingFiles {
  exists(path: string): boolean;
  read(path: string): string;
  /** The permission bits of the file. */
  mode(path: string): number;
}

export class IncompleteMapping extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`a mapping of your own needs both ${MAPPING_VARIABLES.join(' and ')}; missing: ${missing.join(', ')}`);
    this.name = 'IncompleteMapping';
    this.missing = missing;
  }
}

export class MappingUnusable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MappingUnusable';
  }
}

/**
 * The mapping the developer chose, with the logins its env file holds. Every message here names a setting, a path or a variable
 * name and never a value of the env file.
 */
export function devMapping(env: Readonly<Record<string, string | undefined>>, files: MappingFiles): DevMapping | undefined {
  const [mappingPath, envPath] = MAPPING_VARIABLES.map((name) => env[name] ?? '');
  const missing = MAPPING_VARIABLES.filter((name) => (env[name] ?? '') === '');
  if (missing.length === MAPPING_VARIABLES.length) return undefined;
  if (missing.length > 0 || mappingPath === undefined || envPath === undefined) throw new IncompleteMapping(missing);

  for (const [name, path] of [[MAPPING_VARIABLES[0], mappingPath], [MAPPING_VARIABLES[1], envPath]] as const) {
    if (!isAbsolute(path)) throw new MappingUnusable(`${name} must be an absolute path`);
    if (!files.exists(path)) throw new MappingUnusable(`${name} names a file that does not exist: ${path}`);
  }
  const mode = files.mode(envPath);
  if ((mode & ~0o600) !== 0) throw new MappingUnusable(`${MAPPING_VARIABLES[1]}: ${envPath} has mode 0${mode.toString(8)}, wider than 0600; run chmod 600 on it`);

  const logins: Record<string, string> = {};
  for (const [name, value] of parseEnvFile(files.read(envPath))) {
    if (!NAME.test(name)) throw new MappingUnusable(`${MAPPING_VARIABLES[1]}: ${envPath} holds a name that is not a variable name`);
    if (RESERVED.test(name)) throw new MappingUnusable(`${MAPPING_VARIABLES[1]}: ${envPath} sets ${name}, which the tool sets itself; remove it from that file`);
    if (value === '') throw new MappingUnusable(`${MAPPING_VARIABLES[1]}: ${envPath} gives ${name} an empty value`);
    logins[name] = value;
  }
  if (Object.keys(logins).length === 0) throw new MappingUnusable(`${MAPPING_VARIABLES[1]}: ${envPath} holds no settings`);
  return { mappingPath, logins };
}

/** Whether `dev up` would use no container at all: a mapping of your own and an external Postgres, every setting non-empty. Reads no file. */
export function startsNoContainers(env: Readonly<Record<string, string | undefined>>): boolean {
  return [...MAPPING_VARIABLES, ...EXTERNAL_VARIABLES].every((name) => (env[name] ?? '') !== '');
}
