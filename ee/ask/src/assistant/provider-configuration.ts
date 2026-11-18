import type { ProviderConfiguration } from '@neburyx/ee-ai-runtime';
import type { AssistantSettings } from './settings.js';

/** The configuration of the assistant's own provider: its model, its per-call timeout, the output limit of a reply and no retry inside the client library, whatever Ask is set to. */
export function assistantProviderConfiguration(base: ProviderConfiguration, settings: AssistantSettings): ProviderConfiguration {
  return { ...base, model: settings.model, limits: { ...base.limits, timeoutMs: settings.timeoutMs, maxRetries: 0, maxTokens: settings.maxOutputTokens } };
}
