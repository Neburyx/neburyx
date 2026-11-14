import { access, constants, readFile, stat } from 'node:fs/promises';
import { AI_CACHE_TTLS, AI_DEFAULTS, AI_EFFORTS, AI_LIMITS, AI_PROVIDERS, type AiCacheTtl, type AiEffort, type ConfigureOutcome } from '@neburyx/contracts';
import { parseKeyText } from './key-file.js';

type KeyReference = { readonly kind: 'env'; readonly name: string } | { readonly kind: 'file'; readonly path: string };

export interface AskConfiguration {
  readonly provider: 'anthropic';
  readonly model: string;
  readonly key: KeyReference;
  readonly cache: { readonly enabled: boolean; readonly ttl: AiCacheTtl };
  /** The folder of the intents and the classification text; read once at start-up. */
  readonly mappingFolder: string;
  readonly limits: { readonly timeoutMs: number; readonly maxRetries: number; readonly maxTokens: number; readonly effort: AiEffort };
}

const GROUP_AND_OTHER_BITS = 0o077;

type Env = Readonly<Record<string, string | undefined>>;

const ASK_VARIABLES = {
  provider: 'NEBURYX_ASK_PROVIDER',
  model: 'NEBURYX_ASK_CLASSIFICATION_MODEL',
  key: 'NEBURYX_ASK_API_KEY',
  keyFile: 'NEBURYX_ASK_API_KEY_FILE',
  folder: 'NEBURYX_ASK_MAPPING_FOLDER',
  effort: 'NEBURYX_ASK_EFFORT',
  timeoutMs: 'NEBURYX_ASK_TIMEOUT_MS',
  maxRetries: 'NEBURYX_ASK_MAX_RETRIES',
  maxTokens: 'NEBURYX_ASK_MAX_TOKENS',
} as const;

/** The model Ask classifies with when none is named: the smallest model of the current family. */
export const DEFAULT_ASK_MODEL = 'claude-haiku-5-5';

/** An empty value counts as not set, as for the cache variables. */
const given = (env: Env, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
};

async function keyFileProblems(path: string): Promise<readonly string[]> {
  const name = ASK_VARIABLES.keyFile;
  let found;
  try {
    found = await stat(path);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    return [`${name}: the file ${code === 'ENOENT' ? 'does not exist' : 'cannot be inspected'}`];
  }
  if (!found.isFile()) return [`${name}: the path is not a regular file`];
  if (found.size === 0) return [`${name}: the file is empty`];
  if ((found.mode & GROUP_AND_OTHER_BITS) !== 0) return [`${name}: the file can be read by group or others; owner-only access is required (mode 0600)`];
  try {
    await access(path, constants.R_OK);
  } catch {
    return [`${name}: the file cannot be read by this process`];
  }
  const parsed = parseKeyText(await readFile(path, 'utf8').catch(() => ''));
  return parsed.ok ? [] : [`${name}: ${parsed.problem}`];
}

/** Exactly one of the key and the key file; the value of the key is never read into a message. */
async function keyChoice(env: Env): Promise<{ readonly key?: KeyReference; readonly problems: readonly string[] }> {
  const direct = given(env, ASK_VARIABLES.key);
  const file = given(env, ASK_VARIABLES.keyFile);
  if (direct !== undefined && file !== undefined) return { problems: [`${ASK_VARIABLES.key} and ${ASK_VARIABLES.keyFile} are both set; set one`] };
  if (direct !== undefined) return { key: { kind: 'env', name: ASK_VARIABLES.key }, problems: [] };
  if (file === undefined) return { problems: [`${ASK_VARIABLES.key} or ${ASK_VARIABLES.keyFile} is required when the AI preview is on`] };
  if (!file.startsWith('/')) return { problems: [`${ASK_VARIABLES.keyFile} must be an absolute path`] };
  const problems = await keyFileProblems(file);
  return problems.length > 0 ? { problems } : { key: { kind: 'file', path: file }, problems: [] };
}

function integerChoice(env: Env, name: string, limits: { readonly min: number; readonly max: number }, fallback: number, problems: string[]): number {
  const value = given(env, name);
  if (value === undefined) return fallback;
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < limits.min || parsed > limits.max) {
    problems.push(`${name} must be a whole number from ${limits.min} to ${limits.max}`);
    return fallback;
  }
  return parsed;
}

const CACHE_SWITCH_VARIABLE = 'NEBURYX_AI_CACHE';
const CACHE_TTL_VARIABLE = 'NEBURYX_AI_CACHE_TTL';

type CacheChoice = { readonly enabled: boolean; readonly ttl: AiCacheTtl; readonly problems: readonly string[] };

/** An empty value counts as not set, and a value that is set and not one of the accepted ones is a problem that names the variable and never repeats the value. */
function cacheChoice(env: Env): CacheChoice {
  const problems: string[] = [];
  let enabled: boolean = AI_DEFAULTS.cache.enabled;
  let ttl: AiCacheTtl = AI_DEFAULTS.cache.ttl;
  const given = env[CACHE_SWITCH_VARIABLE];
  if (given !== undefined && given !== '') {
    if (given === 'on' || given === 'off') enabled = given === 'on';
    else problems.push(`${CACHE_SWITCH_VARIABLE} must be on or off`);
  }
  const lifetime = env[CACHE_TTL_VARIABLE];
  if (lifetime !== undefined && lifetime !== '') {
    const accepted = AI_CACHE_TTLS.find((candidate) => candidate === lifetime);
    if (accepted !== undefined) ttl = accepted;
    else problems.push(`${CACHE_TTL_VARIABLE} must be ${AI_CACHE_TTLS.join(' or ')}`);
  }
  return { enabled, ttl, problems };
}

export type Configuration = { readonly outcome: ConfigureOutcome; readonly configuration?: AskConfiguration };

/** Checks the settings of Ask, which are in the environment; reads the key file's rights and form but never puts a value in a message. */
export async function configureAsk(env: Env): Promise<Configuration> {
  const problems: string[] = [];
  const provider = given(env, ASK_VARIABLES.provider) ?? AI_PROVIDERS[0];
  if (!AI_PROVIDERS.some((known) => known === provider)) problems.push(`${ASK_VARIABLES.provider} must be ${AI_PROVIDERS.join(' or ')}`);
  const model = given(env, ASK_VARIABLES.model) ?? DEFAULT_ASK_MODEL;
  const folder = given(env, ASK_VARIABLES.folder);
  if (folder === undefined) problems.push(`${ASK_VARIABLES.folder} is required when the AI preview is on`);
  else if (!folder.startsWith('/')) problems.push(`${ASK_VARIABLES.folder} must be an absolute path`);
  const chosen = await keyChoice(env);
  problems.push(...chosen.problems);
  const effort = given(env, ASK_VARIABLES.effort) ?? AI_DEFAULTS.effort;
  const knownEffort = AI_EFFORTS.find((candidate) => candidate === effort);
  if (knownEffort === undefined) problems.push(`${ASK_VARIABLES.effort} must be ${AI_EFFORTS.join(', ')}`);
  const timeoutMs = integerChoice(env, ASK_VARIABLES.timeoutMs, AI_LIMITS.timeoutMs, AI_DEFAULTS.timeoutMs, problems);
  const maxRetries = integerChoice(env, ASK_VARIABLES.maxRetries, AI_LIMITS.maxRetries, AI_DEFAULTS.maxRetries, problems);
  const maxTokens = integerChoice(env, ASK_VARIABLES.maxTokens, AI_LIMITS.maxTokens, AI_DEFAULTS.maxTokens, problems);
  // The client library merges this variable into the headers of every request, after the credential headers.
  if (env.ANTHROPIC_CUSTOM_HEADERS !== undefined) problems.push('ANTHROPIC_CUSTOM_HEADERS is set in the environment; the AI preview refuses it because it would add headers to every call');
  const cache = cacheChoice(env);
  problems.push(...cache.problems);

  if (problems.length > 0 || chosen.key === undefined || folder === undefined || knownEffort === undefined || provider !== 'anthropic') {
    return { outcome: { ok: false, problems } };
  }
  return {
    outcome: { ok: true },
    configuration: {
      provider,
      model,
      key: chosen.key,
      cache: { enabled: cache.enabled, ttl: cache.ttl },
      mappingFolder: folder,
      limits: { timeoutMs, maxRetries, maxTokens, effort: knownEffort },
    },
  };
}
