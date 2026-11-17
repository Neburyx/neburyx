import type { ProviderConfiguration } from '@neburyx/ee-ai-runtime';
import type { SummarySettings } from './settings.js';

/** The configuration of the summary's own provider: its model, its per-call timeout, the output limit of a summary and no retry inside the client library, whatever Ask is set to. Ask's own configuration is not changed. */
export function summaryProviderConfiguration(ask: ProviderConfiguration, settings: SummarySettings): ProviderConfiguration {
  return { ...ask, model: settings.model, limits: { ...ask.limits, timeoutMs: settings.timeoutMs, maxRetries: 0, maxTokens: settings.maxOutputTokens } };
}
