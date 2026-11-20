import { AI_DEFAULTS } from '@neburyx/contracts';
import { createAnthropicProvider } from '@neburyx/ee-ai-runtime';
import { DEFAULT_ASK_MODEL } from '@neburyx/ee-ai-runtime';
import { configureAsk } from '../configure.js';
import type { ModelProvider } from '@neburyx/ee-ai-runtime';
import { summaryProviderConfiguration } from '../case-summary/provider-configuration.js';
import type { SummarySettings } from '../case-summary/settings.js';
import { assistantProviderConfiguration } from '../assistant/provider-configuration.js';
import { readAssistantSettings } from '../assistant/settings.js';

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

/** The configuration of Ask for a run, built the way the product builds its own: through `configureAsk`, with the key from `NEBURYX_ASK_API_KEY_FILE` only and no retry. */
async function askConfigurationFor(env: Env, folder: string) {
  if (env['NEBURYX_ASK_API_KEY'] !== undefined && env['NEBURYX_ASK_API_KEY'] !== '') throw new LiveProviderError('NEBURYX_ASK_API_KEY is not used by an evaluation run: give the key as NEBURYX_ASK_API_KEY_FILE');
  const given = env['NEBURYX_ASK_MAPPING_FOLDER'];
  if (given !== undefined && given !== '' && given !== folder) throw new LiveProviderError('NEBURYX_ASK_MAPPING_FOLDER names another folder than the one given');
  const kept: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) if (KEPT.test(name) || name === 'ANTHROPIC_CUSTOM_HEADERS') kept[name] = value;
  const used = { ...kept, NEBURYX_ASK_MAPPING_FOLDER: folder, NEBURYX_ASK_MAX_RETRIES: '0' };
  const configured = await configureAsk(used);
  if (!configured.outcome.ok || configured.configuration === undefined) throw new LiveProviderError(configured.outcome.ok ? 'the settings of Ask could not be used' : configured.outcome.problems.join('; '));
  if (configured.configuration.key.kind !== 'file') throw new LiveProviderError('the key must be given as NEBURYX_ASK_API_KEY_FILE');
  return { configuration: configured.configuration, used };
}

/**
 * The provider of a recording run: a key file that others can read, an empty one or a missing one is refused before any call, retries are forced to 0, and the folder is the one given. A message holds no part of the key.
 */
export async function liveProvider(env: Env, folder: string): Promise<{ readonly provider: ModelProvider; readonly model: string; readonly effort: string; readonly maxRetries: number }> {
  const { configuration, used } = await askConfigurationFor(env, folder);
  return { provider: createAnthropicProvider({ configuration, env: used }), model: configuration.model, effort: configuration.limits.effort, maxRetries: configuration.limits.maxRetries };
}

/** The provider of a summary run: the provider of the summary's own configuration (its model, its timeout, its output limit, no retry), built the way `liveProvider` builds Ask's. */
export async function liveSummaryProvider(env: Env, folder: string, settings: SummarySettings): Promise<{ readonly provider: ModelProvider; readonly model: string; readonly maxRetries: number; readonly cacheEnabled: boolean }> {
  const { configuration, used } = await askConfigurationFor(env, folder);
  const own = summaryProviderConfiguration(configuration, settings);
  return { provider: createAnthropicProvider({ configuration: own, env: used }), model: own.model, maxRetries: own.limits.maxRetries, cacheEnabled: own.cache.enabled };
}

const ASSISTANT_KEPT = /^NEBURYX_ASSISTANT_/;

function assistantSettingsOf(env: Env, model: string | undefined) {
  const kept: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) if (ASSISTANT_KEPT.test(name)) kept[name] = value;
  const read = readAssistantSettings({ ...kept, ...(model === undefined ? {} : { NEBURYX_ASSISTANT_MODEL: model }) });
  if (!read.ok) throw new LiveProviderError(read.problems.join('; '));
  return read.settings;
}

/** What an assistant run will use, without a key and without reading a key file: the model (the setting, or the one given), the effort and the output limit of a reply. */
export function assistantRunSettings(env: Env, model?: string): { readonly model: string; readonly effort: string; readonly outputLimit: number } {
  const settings = assistantSettingsOf(env, model);
  const given = env['NEBURYX_ASK_EFFORT'];
  return { model: settings.model, effort: given === undefined || given === '' ? AI_DEFAULTS.effort : given, outputLimit: settings.maxOutputTokens };
}

/** The provider of an assistant recording run: the provider of the assistant's own configuration (its model, its timeout, its output limit, no retry), built the way `liveProvider` builds Ask's, with the key from `NEBURYX_ASK_API_KEY_FILE` only. */
export async function liveAssistantProvider(env: Env, folder: string, model?: string): Promise<{ readonly provider: ModelProvider; readonly model: string; readonly effort: string; readonly outputLimit: number; readonly maxRetries: number }> {
  const { configuration, used } = await askConfigurationFor(env, folder);
  const settings = assistantSettingsOf(env, model);
  const own = assistantProviderConfiguration(configuration, settings);
  return { provider: createAnthropicProvider({ configuration: own, env: used }), model: own.model, effort: own.limits.effort, outputLimit: own.limits.maxTokens, maxRetries: own.limits.maxRetries };
}
