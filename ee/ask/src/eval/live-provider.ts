import type { AiMappingView, AiSettings } from '@neburyx/contracts';
import { createAnthropicProvider } from '../anthropic.js';
import { configureAsk } from '../configure.js';
import type { ModelProvider } from '../provider.js';

export class LiveProviderError extends Error {}

export interface LiveProviderOptions {
  /** The `ai` settings of the mapping the run uses. */
  readonly settings: AiSettings | undefined;
  /** Replaces the model name of the settings, for the step-up. */
  readonly model: string | undefined;
  readonly view: AiMappingView;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Only a test sets this, to a stub on the loopback address. */
  readonly baseUrl?: string;
}

/**
 * The provider of a recording run, built the way the product builds its own: through `configureAsk`, so a key file that others can read, an empty one or a missing one refuses before any call.
 * The key is read from its file by the provider at each call and appears in no message of this module. A key given as an environment variable is refused here: these runs use the file. A call is never retried.
 */
export async function liveProvider(options: LiveProviderOptions): Promise<{ readonly provider: ModelProvider; readonly model: string }> {
  const { settings } = options;
  if (settings === undefined) throw new LiveProviderError('the mapping has no ai settings');
  if (settings.key?.env !== undefined) throw new LiveProviderError('ai.key.env is not used by a recording run: give the key as ai.key.file');
  if (settings.prompts !== undefined && Object.keys(settings.prompts).length > 0) throw new LiveProviderError('ai.prompts replacements are not used by a recording run: it records the built-in prompts');
  const configured = await configureAsk({ ...settings, ...(options.model === undefined ? {} : { model: options.model }), max_retries: 0 }, options.env, options.view);
  if (!configured.outcome.ok || configured.configuration === undefined) {
    throw new LiveProviderError(configured.outcome.ok ? 'the ai settings could not be used' : configured.outcome.problems.join('; '));
  }
  const { configuration } = configured;
  return { provider: createAnthropicProvider({ configuration, env: options.env, ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }) }), model: configuration.model };
}
