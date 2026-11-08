import { isAbsolute } from 'node:path';
import type { DevConfig } from './config.js';
import type { Environment } from './environments.js';
import type { Files } from './files.js';
import { parseEnvFile } from './settings.js';

/** Names the tool sets itself for the API, or that change how a program starts; a login file never supplies them. */
const RESERVED = /^(PATH|HOME|TMPDIR|LANG|NODE_.*|DATABASE_.*|NEBURYX_.*|DEMO_NEO4J_.*)$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface DevMapping {
  readonly mappingPath: string;
  readonly logins: Environment;
}

export class MappingUnusable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MappingUnusable';
  }
}

/**
 * The mapping the developer chose, with the logins its env file holds. Every message names a setting or a variable name and never
 * a path or a value of the settings file or of the env file.
 */
export function devMapping(config: DevConfig, files: Files): DevMapping {
  const mappingPath = config.NEBURYX_DEV_MAPPING;
  const envPath = config.NEBURYX_DEV_MAPPING_ENV;
  const ENV = 'NEBURYX_DEV_MAPPING_ENV';

  for (const [name, path] of [['NEBURYX_DEV_MAPPING', mappingPath], [ENV, envPath]] as const) {
    if (!isAbsolute(path)) throw new MappingUnusable(`${name} must be an absolute path`);
    if (!files.exists(path)) throw new MappingUnusable(`${name} names a file that does not exist`);
  }
  const mode = files.mode(envPath);
  if ((mode & ~0o600) !== 0) throw new MappingUnusable(`${ENV}: the file has mode 0${mode.toString(8)}, wider than 0600; run chmod 600 on it`);

  const logins: Record<string, string> = {};
  for (const [name, value] of parseEnvFile(files.read(envPath))) {
    if (!NAME.test(name)) throw new MappingUnusable(`${ENV}: the file holds a name that is not a variable name`);
    if (RESERVED.test(name)) throw new MappingUnusable(`${ENV}: the file sets ${name}, which the tool sets itself; remove it from that file`);
    if (value === '') throw new MappingUnusable(`${ENV}: the file gives ${name} an empty value`);
    logins[name] = value;
  }
  if (Object.keys(logins).length === 0) throw new MappingUnusable(`${ENV}: the file holds no settings`);
  return { mappingPath, logins };
}
