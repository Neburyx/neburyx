import type { AskConfiguration } from '../configure.js';
import { SUMMARY_MAX_OUTPUT_TOKENS } from './draft.js';
import type { SummarySettings } from './settings.js';

/** The configuration of the summary's own provider: its model, its per-call timeout, the output limit of a summary and no retry inside the client library, whatever Ask is set to. Ask's own configuration is not changed. */
export function summaryProviderConfiguration(ask: AskConfiguration, settings: SummarySettings): AskConfiguration {
  return { ...ask, model: settings.model, limits: { ...ask.limits, timeoutMs: settings.timeoutMs, maxRetries: 0, maxTokens: SUMMARY_MAX_OUTPUT_TOKENS } };
}
