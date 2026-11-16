import { budgetedProvider, evalSummarizer, liveSummaryProvider, scriptedSummaryProvider, summaryRunSettings } from '@neburyx/ee-ask/eval';
import type { ModelProvider } from '@neburyx/ee-ask';
import type { EvalHooks } from '../eval/hooks.js';

/** The hooks of the entry script, built here for the tests; a test replaces one of them to script a case. */
export const realHooks: EvalHooks<ModelProvider> = {
  settings: (env) => summaryRunSettings(env),
  scriptedProvider: (replyFor) => scriptedSummaryProvider(replyFor),
  liveProvider: (env, folder, settings) => liveSummaryProvider(env, folder, settings),
  budgeted: (inner, budget, onRequest) => budgetedProvider(inner, budget, onRequest),
  summarizer: (options) => evalSummarizer(options),
};
