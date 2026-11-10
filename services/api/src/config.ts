import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8080;

const MAX_PORT = 65535;

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function isValidHost(host: string): boolean {
  if (isIP(host) !== 0) return true;
  if (/^[\d.]+$/.test(host)) return false;
  return HOSTNAME.test(host);
}

const keys = {
  host: 'NEBURYX_HOST',
  port: 'NEBURYX_PORT',
  webRoot: 'NEBURYX_WEB_ROOT',
  databaseUrl: 'DATABASE_URL',
  mappingPath: 'NEBURYX_CONFIG',
  cursorKey: 'NEBURYX_CURSOR_KEY',
  exportDirectory: 'NEBURYX_EXPORT_DIR',
} as const;

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) return false;
    for (const part of [url.username, url.password, url.hostname, url.pathname]) decodeURIComponent(part);
    return true;
  } catch {
    return false;
  }
}

const MIN_CURSOR_KEY_BYTES = 32;

/** Standard base64, padding optional, with no second spelling, that holds at least 32 bytes. */
function decodeCursorKey(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64');
  const canonical = bytes.toString('base64');
  // exactly the padded text of those bytes, or the same text with no padding at all
  if (value !== canonical && value !== canonical.replace(/=+$/, '')) return undefined;
  return bytes.length >= MIN_CURSOR_KEY_BYTES ? bytes : undefined;
}

/** Where export files are kept when the setting is absent; the image creates it. */
export const DEFAULT_EXPORT_DIRECTORY = '/data/exports';

const configSchema = z.object({
  host: z.string().min(1).refine(isValidHost),
  port: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_PORT)),
  webRoot: z.string().min(1).transform((path) => resolve(path)),
  databaseUrl: z.string().refine(isPostgresUrl),
  mappingPath: z.string().min(1).transform((path) => resolve(path)).optional(),
  exportDirectory: z.string().refine((path) => isAbsolute(path)),
  /** The key that signs page cursors; absent, the API makes one of its own for the process. */
  cursorKey: z
    .string()
    .transform((value, context) => {
      const key = decodeCursorKey(value);
      if (key === undefined) context.addIssue({ code: 'custom', message: 'not a cursor key' });
      return key ?? Buffer.alloc(0);
    })
    .optional(),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  readonly keys: readonly string[];

  constructor(failedKeys: readonly string[]) {
    super(`invalid configuration: ${failedKeys.join(', ')}`);
    this.keys = failedKeys;
  }
}

export function parseConfig(
  env: Readonly<Record<string, string | undefined>>,
  defaults: { readonly webRoot: string; readonly exportDirectory?: string },
): Config {
  const result = configSchema.safeParse({
    host: env[keys.host] ?? DEFAULT_HOST,
    port: env[keys.port] ?? String(DEFAULT_PORT),
    webRoot: env[keys.webRoot] ?? defaults.webRoot,
    databaseUrl: env[keys.databaseUrl],
    mappingPath: env[keys.mappingPath],
    cursorKey: env[keys.cursorKey],
    exportDirectory: env[keys.exportDirectory] ?? defaults.exportDirectory ?? DEFAULT_EXPORT_DIRECTORY,
  });
  if (result.success) return result.data;

  const failed = result.error.issues.flatMap((issue) => {
    const field = issue.path[0];
    return field === 'host' || field === 'port' || field === 'webRoot' || field === 'databaseUrl' || field === 'mappingPath' || field === 'cursorKey' || field === 'exportDirectory' ? [keys[field]] : [];
  });
  throw new ConfigError([...new Set(failed)]);
}

const commandConfigSchema = configSchema.pick({ databaseUrl: true, mappingPath: true });

export type CommandConfig = z.infer<typeof commandConfigSchema>;

/** The settings a command that talks to the database and reads the mapping needs; the server's host, port and web folder do not matter to it. */
export function parseCommandConfig(env: Readonly<Record<string, string | undefined>>): CommandConfig {
  const result = commandConfigSchema.safeParse({ databaseUrl: env[keys.databaseUrl], mappingPath: env[keys.mappingPath] });
  if (result.success) return result.data;
  const failed = result.error.issues.flatMap((issue) => (issue.path[0] === 'databaseUrl' || issue.path[0] === 'mappingPath' ? [keys[issue.path[0]]] : []));
  throw new ConfigError([...new Set(failed)]);
}
