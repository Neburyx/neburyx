import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ENV_URI = 'NBX_EE_URI';
export const ENV_USER = 'NBX_EE_USER';
export const ENV_PASSWORD = 'NBX_EE_PASSWORD';
export const ENV_NAMES = [ENV_URI, ENV_USER, ENV_PASSWORD] as const;

/** The file a developer keeps the three variables in, outside the repositories, readable by the owner only. */
export const DEV_ENV_FILE = join(homedir(), '.config', 'neburyx', 'dev-neo4j.env');

/** What every object the tests create on the shared server starts with; a login that starts with it is refused, so that the sweep can never reach it. */
export const USER_PREFIX = 'nbx_test_';
export const DATABASE_PREFIX = 'nbx-test-';

export interface DevSettings {
  readonly uri: string;
  readonly user: string;
  readonly password: string;
}

/** Thrown when the dev server's connection is not given; names the variables that are missing and never a value. */
export class DevNeo4jNotConfigured extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[], file: string) {
    super(`the Neo4j tests need ${missing.join(', ')}: set them in the environment or in ${file} (one NAME=value per line, mode 0600)`);
    this.name = 'DevNeo4jNotConfigured';
    this.missing = missing;
  }
}

/** Reads `NAME=value` lines, with an optional `export ` and optional quotes around the value; comment and blank lines are skipped. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match === null || line.trimStart().startsWith('#')) continue;
    const name = match[1] ?? '';
    let value = match[2] ?? '';
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    values[name] = value;
  }
  return values;
}

function readFileIfThere(file: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(file, 'utf8'));
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
}

/**
 * The connection of the dev server, from the environment first and then from the file when it is there. Missing variables are an error that names them;
 * nothing falls back to a default, so a test run never passes or skips for want of a server. A login whose name starts with the test prefix is refused.
 */
export function devSettings(env: Readonly<Record<string, string | undefined>> = process.env, file: string = DEV_ENV_FILE): DevSettings {
  const fromFile = ENV_NAMES.every((name) => (env[name] ?? '') !== '') ? {} : readFileIfThere(file);
  const value = (name: string): string => ((env[name] ?? '') !== '' ? (env[name] ?? '') : (fromFile[name] ?? ''));
  const missing = ENV_NAMES.filter((name) => value(name) === '');
  if (missing.length > 0) throw new DevNeo4jNotConfigured(missing, file);
  const settings = { uri: value(ENV_URI), user: value(ENV_USER), password: value(ENV_PASSWORD) };
  assertDevSettings(settings);
  return settings;
}

/** The checks every way into the server goes through, so settings given by hand are held to them too: a bolt address, and a login that is not one of the tests' own. */
export function assertDevSettings(settings: DevSettings): void {
  if (!/^(bolt|neo4j)(\+s|\+ssc)?:\/\//.test(settings.uri)) throw new Error(`${ENV_URI} is not a bolt or neo4j address`);
  if (settings.user === '' || settings.password === '') throw new Error(`${ENV_USER} and ${ENV_PASSWORD} must not be empty`);
  if (settings.user.startsWith(USER_PREFIX)) throw new Error(`${ENV_USER} starts with ${USER_PREFIX}: the tests clean up logins with that prefix, so the login they use must not have it`);
}

/**
 * The settings with the host of a plain address replaced by its IPv4 address. A host name of the local network (`.local`) can wait five seconds for an IPv6 answer
 * that never comes before every connection, which is longer than a source waits for one; resolving once, for IPv4, does not. An address with a certificate (`+s`),
 * a host that is already an address and one that does not resolve are left as they are.
 */
export async function fastSettings(settings: DevSettings, find: (host: string) => Promise<string | undefined> = findIpv4): Promise<DevSettings> {
  let url: URL;
  try {
    url = new URL(settings.uri);
  } catch {
    return settings;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol.includes('+s:') || isIP(host) !== 0) return settings;
  const found = await find(host).catch(() => undefined);
  if (found === undefined) return settings;
  url.hostname = found;
  return { ...settings, uri: url.toString().replace(/\/$/, '') };
}

async function findIpv4(host: string): Promise<string | undefined> {
  const found = await lookup(host, { family: 4 });
  return found.address;
}
