import { AI_DEFAULTS } from '@neburyx/contracts';
import { createAnthropicProvider } from '../anthropic.js';
import { configureAsk, DEFAULT_ASK_MODEL } from './../configure.js';
import type { ModelProvider } from '../provider.js';

type Env = Readonly<Record<string, string | undefined>>;

/** The variables of Ask that a recording run takes from the environment; every other variable, including each `ANTHROPIC_*` one except the refused headers, is left out. */
const KEPT = /^(NEBURYX_ASK_|NEBURYX_AI_)/;

export class LiveProviderError extends Error {
  override readonly name = 'LiveProviderError';
}

/** What a run will use, without a key and without reading a key file: the model and the effort. */
export function runSettings(env: Env): { readonly model: string; readonly effort: string } {
  const given = (name: string): string | undefined => (env[name] === undefined || env[name] === '' ? undefined : env[name]);
  return { model: given('NEBURYX_ASK_CLASSIFICATION_MODEL') ?? DEFAULT_ASK_MODEL, effort: given('NEBURYX_ASK_EFFORT') ?? AI_DEFAULTS.effort };
}

/**
 * The provider of a recording run, built the way the product builds its own: through `configureAsk`, so a key file that others can read, an empty one or a missing one is refused before any call.
 * The key comes from `NEBURYX_ASK_API_KEY_FILE` only (a key in the environment is refused), retries are forced to 0, and the folder is the one given. A message holds no part of the key.
 */
export async function liveProvider(env: Env, folder: string): Promise<{ readonly provider: ModelProvider; readonly model: string; readonly effort: string; readonly maxRetries: number }> {
  if (env['NEBURYX_ASK_API_KEY'] !== undefined && env['NEBURYX_ASK_API_KEY'] !== '') throw new LiveProviderError('NEBURYX_ASK_API_KEY is not used by a recording run: give the key as NEBURYX_ASK_API_KEY_FILE');
  const given = env['NEBURYX_ASK_MAPPING_FOLDER'];
  if (given !== undefined && given !== '' && given !== folder) throw new LiveProviderError('NEBURYX_ASK_MAPPING_FOLDER names another folder than the one given');
  const kept: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) if (KEPT.test(name) || name === 'ANTHROPIC_CUSTOM_HEADERS') kept[name] = value;
  const used = { ...kept, NEBURYX_ASK_MAPPING_FOLDER: folder, NEBURYX_ASK_MAX_RETRIES: '0' };
  const configured = await configureAsk(used);
  if (!configured.outcome.ok || configured.configuration === undefined) throw new LiveProviderError(configured.outcome.ok ? 'the settings of Ask could not be used' : configured.outcome.problems.join('; '));
  const { configuration } = configured;
  if (configuration.key.kind !== 'file') throw new LiveProviderError('the key must be given as NEBURYX_ASK_API_KEY_FILE');
  return { provider: createAnthropicProvider({ configuration, env: used }), model: configuration.model, effort: configuration.limits.effort, maxRetries: configuration.limits.maxRetries };
}
