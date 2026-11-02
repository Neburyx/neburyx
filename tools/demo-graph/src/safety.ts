import type { MappingSource } from './mapping.js';

export type SafetyReason = 'source-not-synthetic' | 'mapping-address' | 'override-address' | 'credentials-missing' | 'database-not-empty';

export class SafetyError extends Error {
  readonly reason: SafetyReason;

  constructor(reason: SafetyReason, message: string) {
    super(message);
    this.name = 'SafetyError';
    this.reason = reason;
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

export function isDemoAddress(address: string): boolean {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '') return false;
  if (LOOPBACK.has(host)) return true;
  return !host.includes('.') && !host.includes(':') && /^[a-z0-9-]+$/.test(host) && !/^\d+$/.test(host);
}

export interface Credentials {
  readonly user: string;
  readonly password: string;
}

export function checkOffline(source: MappingSource, override: string | undefined, env: Readonly<Record<string, string | undefined>>): Credentials {
  if (!source.synthetic) throw new SafetyError('source-not-synthetic', `the source ${source.id} is not marked synthetic: true, so the loader will not write to it`);
  if (!isDemoAddress(source.uri)) throw new SafetyError('mapping-address', `the address in the mapping for ${source.id} is not a loopback address or a single-label host name`);
  if (override !== undefined && !isDemoAddress(override)) throw new SafetyError('override-address', `the address given on the command line for ${source.id} is not a loopback address or a single-label host name`);
  const user = env[source.usernameEnv];
  const password = env[source.passwordEnv];
  const missing = [source.usernameEnv, source.passwordEnv].filter((name) => (env[name] ?? '') === '');
  if (user === undefined || password === undefined || missing.length > 0) {
    throw new SafetyError('credentials-missing', `the credential variables ${missing.join(' and ')} for ${source.id} are not set`);
  }
  return { user, password };
}
