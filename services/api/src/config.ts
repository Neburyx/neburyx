import { isIP } from 'node:net';
import { resolve } from 'node:path';
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

const keys = { host: 'NEBURYX_HOST', port: 'NEBURYX_PORT', webRoot: 'NEBURYX_WEB_ROOT' } as const;

const configSchema = z.object({
  host: z.string().min(1).refine(isValidHost),
  port: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_PORT)),
  webRoot: z.string().min(1).transform((path) => resolve(path)),
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
  defaults: { readonly webRoot: string },
): Config {
  const result = configSchema.safeParse({
    host: env[keys.host] ?? DEFAULT_HOST,
    port: env[keys.port] ?? String(DEFAULT_PORT),
    webRoot: env[keys.webRoot] ?? defaults.webRoot,
  });
  if (result.success) return result.data;

  const failed = result.error.issues.flatMap((issue) => {
    const field = issue.path[0];
    return field === 'host' || field === 'port' || field === 'webRoot' ? [keys[field]] : [];
  });
  throw new ConfigError([...new Set(failed)]);
}
