import { AI_DEFAULTS } from '@neburyx/contracts';
import { LocalProviderSettingError, createAnthropicProvider, createLocalProvider } from '@neburyx/ee-ai-runtime';
import { DEFAULT_ASK_MODEL } from '@neburyx/ee-ai-runtime';
import { configureAsk } from '../configure.js';
import type { ModelProvider, ProviderConfiguration } from '@neburyx/ee-ai-runtime';
import { summaryProviderConfiguration } from '../case-summary/provider-configuration.js';
import type { SummarySettings } from '../case-summary/settings.js';
import { assistantProviderConfiguration } from '../assistant/provider-configuration.js';
import { readAssistantSettings } from '../assistant/settings.js';
import { schemasOf, type EvalKind, type JsonSchema } from './local-schemas.js';

type Env = Readonly<Record<string, string | undefined>>;

/** The variables of Ask that a recording run takes from the environment; every other variable, including each `ANTHROPIC_*` one except the refused headers, is left out. */
const KEPT = /^(NEBURYX_ASK_|NEBURYX_AI_)/;

export class LiveProviderError extends Error {
  override readonly name = 'LiveProviderError';
}

const LOCAL_URL = 'NEBURYX_EVAL_LOCAL_URL';
const LOCAL_GRAMMAR = 'NEBURYX_EVAL_LOCAL_GRAMMAR';
const LOCAL_THINKING = 'NEBURYX_EVAL_LOCAL_THINKING';
const LOCAL_KEY_PLACEHOLDER = 'a-local-run-sends-no-key';
const PROBE_VALUES = 'Reply with one JSON object that fits the response form.';

interface LocalRun {
  readonly baseUrl: string;
  readonly grammar: boolean;
  readonly thinking?: 'off';
}

/** What a run says of the provider it used, for its record: figures and names only. */
export interface ProviderLabel {
  readonly kind: 'anthropic' | 'local';
  /** For a local run: whether a json_schema grammar constrained the replies, the prompts that had one, and the outcome of the one probe call that tried each schema before the first call of the set. */
  readonly grammar?: boolean;
  readonly grammarPrompts?: readonly string[];
  readonly probe?: 'accepted';
  /** `off` for a local run that asked the model not to think; absent for the model's own default. */
  readonly thinking?: 'off';
}

const ANTHROPIC_LABEL: ProviderLabel = { kind: 'anthropic' };

/** The evaluation's own settings for a local server: absent for an Anthropic run. Both are needed together, and the grammar is named, never defaulted. */
export function localRunOf(env: Env): LocalRun | undefined {
  const given = (name: string): string | undefined => (env[name] === undefined || env[name] === '' ? undefined : env[name]);
  const url = given(LOCAL_URL);
  const grammar = given(LOCAL_GRAMMAR);
  if (url === undefined) {
    if (grammar !== undefined || given(LOCAL_THINKING) !== undefined) throw new LiveProviderError(`${LOCAL_GRAMMAR} and ${LOCAL_THINKING} are set without ${LOCAL_URL}`);
    return undefined;
  }
  if (grammar !== 'on' && grammar !== 'off') throw new LiveProviderError(`${LOCAL_GRAMMAR} must be on or off when ${LOCAL_URL} is set`);
  const thinking = given(LOCAL_THINKING);
  if (thinking !== undefined && thinking !== 'on' && thinking !== 'off') throw new LiveProviderError(`${LOCAL_THINKING} must be on or off`);
  return { baseUrl: url, grammar: grammar === 'on', ...(thinking === 'off' ? { thinking: 'off' as const } : {}) };
}

/** What a run will use, without a key and without reading a key file: the model and the effort. */
export function runSettings(env: Env): { readonly model: string; readonly effort: string } {
  const given = (name: string): string | undefined => (env[name] === undefined || env[name] === '' ? undefined : env[name]);
  return { model: given('NEBURYX_ASK_CLASSIFICATION_MODEL') ?? DEFAULT_ASK_MODEL, effort: given('NEBURYX_ASK_EFFORT') ?? AI_DEFAULTS.effort };
}

/** The configuration of Ask for a run, built the way the product builds its own: through `configureAsk`, with the key from `NEBURYX_ASK_API_KEY_FILE` only and no retry. */
async function askConfigurationFor(env: Env, folder: string) {
  const local = localRunOf(env);
  if (env['NEBURYX_ASK_API_KEY'] !== undefined && env['NEBURYX_ASK_API_KEY'] !== '') throw new LiveProviderError('NEBURYX_ASK_API_KEY is not used by an evaluation run: give the key as NEBURYX_ASK_API_KEY_FILE');
  const given = env['NEBURYX_ASK_MAPPING_FOLDER'];
  if (given !== undefined && given !== '' && given !== folder) throw new LiveProviderError('NEBURYX_ASK_MAPPING_FOLDER names another folder than the one given');
  const kept: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) if (KEPT.test(name) || name === 'ANTHROPIC_CUSTOM_HEADERS') kept[name] = value;
  const used = { ...kept, NEBURYX_ASK_MAPPING_FOLDER: folder, NEBURYX_ASK_MAX_RETRIES: '0', ...(local === undefined ? {} : { NEBURYX_ASK_API_KEY: LOCAL_KEY_PLACEHOLDER, NEBURYX_ASK_API_KEY_FILE: undefined }) };
  const configured = await configureAsk(used);
  if (!configured.outcome.ok || configured.configuration === undefined) throw new LiveProviderError(configured.outcome.ok ? 'the settings of Ask could not be used' : configured.outcome.problems.join('; '));
  if (local === undefined && configured.configuration.key.kind !== 'file') throw new LiveProviderError('the key must be given as NEBURYX_ASK_API_KEY_FILE');
  return { configuration: configured.configuration, used, local };
}

/** The provider of a run: the local provider for a local run (no key is read or sent; the limits are those of the configuration, as for an Anthropic run), else the Anthropic provider. A local run with a grammar tries each schema once before the first call of the set. */
async function providerOf(configuration: ProviderConfiguration, used: Env, local: LocalRun | undefined, kind: EvalKind, intents: readonly string[]): Promise<{ readonly provider: ModelProvider; readonly label: ProviderLabel }> {
  if (local === undefined) return { provider: createAnthropicProvider({ configuration, env: used }), label: ANTHROPIC_LABEL };
  const schemas: Readonly<Record<string, JsonSchema>> = local.grammar ? schemasOf(kind, intents) : {};
  let provider: ModelProvider;
  try {
    provider = createLocalProvider({ baseUrl: local.baseUrl, model: configuration.model, limits: { timeoutMs: configuration.limits.timeoutMs, maxTokens: configuration.limits.maxTokens }, ...(local.thinking === undefined ? {} : { thinking: local.thinking }), schemas });
  } catch (error) {
    if (error instanceof LocalProviderSettingError) throw new LiveProviderError(`${LOCAL_URL}: ${error.message}`);
    throw error;
  }
  const prompts = Object.keys(schemas).sort();
  for (const promptId of prompts) {
    const probed = await provider.complete({ promptId, version: 0, values: PROBE_VALUES }, AbortSignal.timeout(configuration.limits.timeoutMs));
    if (probed.status !== 'ok') throw new LiveProviderError(`the probe of the response schema of the prompt ${promptId} did not succeed (${probed.status === 'failed' ? probed.code : probed.status}): the run stops before the first call of the set`);
  }
  return { provider, label: { kind: 'local', grammar: local.grammar, grammarPrompts: prompts, ...(prompts.length === 0 ? {} : { probe: 'accepted' as const }), ...(local.thinking === undefined ? {} : { thinking: 'off' as const }) } };
}

/**
 * The provider of a recording run: a key file that others can read, an empty one or a missing one is refused before any call, retries are forced to 0, and the folder is the one given. A message holds no part of the key.
 */
export async function liveProvider(env: Env, folder: string, intents: readonly string[] = []): Promise<{ readonly provider: ModelProvider; readonly model: string; readonly effort: string; readonly maxRetries: number; readonly label: ProviderLabel }> {
  const { configuration, used, local } = await askConfigurationFor(env, folder);
  const built = await providerOf(configuration, used, local, 'ask', intents);
  return { provider: built.provider, model: configuration.model, effort: configuration.limits.effort, maxRetries: configuration.limits.maxRetries, label: built.label };
}

/** The provider of a summary run: the provider of the summary's own configuration (its model, its timeout, its output limit, no retry), built the way `liveProvider` builds Ask's. */
export async function liveSummaryProvider(env: Env, folder: string, settings: SummarySettings): Promise<{ readonly provider: ModelProvider; readonly model: string; readonly maxRetries: number; readonly cacheEnabled: boolean; readonly label: ProviderLabel }> {
  const { configuration, used, local } = await askConfigurationFor(env, folder);
  const own = summaryProviderConfiguration(configuration, settings);
  const built = await providerOf(own, used, local, 'summary', []);
  return { provider: built.provider, model: own.model, maxRetries: own.limits.maxRetries, cacheEnabled: own.cache.enabled, label: built.label };
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
export async function liveAssistantProvider(env: Env, folder: string, model?: string): Promise<{ readonly provider: ModelProvider; readonly model: string; readonly effort: string; readonly outputLimit: number; readonly maxRetries: number; readonly label: ProviderLabel }> {
  const { configuration, used, local } = await askConfigurationFor(env, folder);
  const settings = assistantSettingsOf(env, model);
  const own = assistantProviderConfiguration(configuration, settings);
  const built = await providerOf(own, used, local, 'assistant', []);
  return { provider: built.provider, model: own.model, effort: own.limits.effort, outputLimit: own.limits.maxTokens, maxRetries: own.limits.maxRetries, label: built.label };
}
