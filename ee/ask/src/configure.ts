import { access, constants, readFile, stat } from 'node:fs/promises';
import { AI_DEFAULTS, AI_CACHE_TTLS, type AiCacheTtl, type AiEffort, type AiMappingView, type AiSettings, type ConfigureOutcome } from '@neburyx/contracts';
import { parseKeyText } from './key-file.js';
import { buildPromptRegistry, type PromptRegistry } from './prompts.js';
import { buildPropertyRules, type PropertyRules } from './rules.js';

export type KeyReference = { readonly kind: 'env'; readonly name: string } | { readonly kind: 'file'; readonly path: string };

export interface AskConfiguration {
  readonly provider: 'anthropic';
  readonly model: string;
  readonly key: KeyReference;
  readonly cache: { readonly enabled: boolean; readonly ttl: AiCacheTtl };
  readonly limits: { readonly timeoutMs: number; readonly maxRetries: number; readonly maxTokens: number; readonly effort: AiEffort };
  readonly registry: PromptRegistry;
  readonly rules: PropertyRules;
}

const GROUP_AND_OTHER_BITS = 0o077;

function requiredProblem(setting: string): string {
  return `${setting} is required when the AI preview is on`;
}

async function keyProblems(key: NonNullable<AiSettings['key']>, env: Readonly<Record<string, string | undefined>>): Promise<readonly string[]> {
  if (key.env !== undefined) {
    const value = env[key.env];
    return value === undefined || value === '' ? [`ai.key.env: the variable ${key.env} is not set or is empty`] : [];
  }
  const path = key.file ?? '';
  let found;
  try {
    found = await stat(path);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    return [`ai.key.file: the file ${code === 'ENOENT' ? 'does not exist' : 'cannot be inspected'}`];
  }
  if (!found.isFile()) return ['ai.key.file: the path is not a regular file'];
  if (found.size === 0) return ['ai.key.file: the file is empty'];
  if ((found.mode & GROUP_AND_OTHER_BITS) !== 0) return ['ai.key.file: the file can be read by group or others; owner-only access is required (mode 0600)'];
  try {
    await access(path, constants.R_OK);
  } catch {
    return ['ai.key.file: the file cannot be read by this process'];
  }
  const parsed = parseKeyText(await readFile(path, 'utf8').catch(() => ''));
  return parsed.ok ? [] : [`ai.key.file: ${path}: ${parsed.problem}`];
}

function referenceOf(key: NonNullable<AiSettings['key']>): KeyReference {
  return key.env !== undefined ? { kind: 'env', name: key.env } : { kind: 'file', path: key.file ?? '' };
}

const CACHE_SWITCH_VARIABLE = 'NEBURYX_AI_CACHE';
const CACHE_TTL_VARIABLE = 'NEBURYX_AI_CACHE_TTL';

type CacheChoice = { readonly enabled: boolean; readonly ttl: AiCacheTtl; readonly problems: readonly string[] };

/** The environment wins over the file; an empty value counts as not set, and a value that is set and not one of the accepted ones is a problem that names the variable and never repeats the value. */
function cacheChoice(settings: AiSettings, env: Readonly<Record<string, string | undefined>>): CacheChoice {
  const problems: string[] = [];
  let enabled: boolean = settings.cache?.enabled ?? AI_DEFAULTS.cache.enabled;
  let ttl: AiCacheTtl = settings.cache?.ttl ?? AI_DEFAULTS.cache.ttl;
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

/** Checks the settings of the AI preview without reading the key, and builds what the routes of the extension use. */
export async function configureAsk(settings: AiSettings, env: Readonly<Record<string, string | undefined>>, view?: AiMappingView): Promise<Configuration> {
  const problems: string[] = [];
  if (settings.provider === undefined) problems.push(requiredProblem('ai.provider'));
  if (settings.model === undefined) problems.push(requiredProblem('ai.model'));
  if (settings.key === undefined) problems.push(requiredProblem('ai.key'));
  else problems.push(...(await keyProblems(settings.key, env)));
  // The client library merges this variable into the headers of every request, after the credential headers.
  if (env.ANTHROPIC_CUSTOM_HEADERS !== undefined) problems.push('ANTHROPIC_CUSTOM_HEADERS is set in the environment; the AI preview refuses it because it would add headers to every call');
  const cache = cacheChoice(settings, env);
  problems.push(...cache.problems);
  const registry = await buildPromptRegistry(settings.prompts);
  if (!registry.ok) problems.push(...registry.problems);
  const properties = buildPropertyRules(settings, view);
  problems.push(...properties.problems);

  if (problems.length > 0 || settings.provider === undefined || settings.model === undefined || settings.key === undefined || !registry.ok || properties.rules === undefined) {
    return { outcome: { ok: false, problems } };
  }
  return {
    outcome: properties.warnings.length > 0 ? { ok: true, warnings: properties.warnings } : { ok: true },
    configuration: {
      provider: settings.provider,
      model: settings.model,
      key: referenceOf(settings.key),
      cache: { enabled: cache.enabled, ttl: cache.ttl },
      limits: {
        timeoutMs: settings.timeout_ms ?? AI_DEFAULTS.timeoutMs,
        maxRetries: settings.max_retries ?? AI_DEFAULTS.maxRetries,
        maxTokens: settings.max_tokens ?? AI_DEFAULTS.maxTokens,
        effort: settings.effort ?? AI_DEFAULTS.effort,
      },
      registry: registry.registry,
      rules: properties.rules,
    },
  };
}
