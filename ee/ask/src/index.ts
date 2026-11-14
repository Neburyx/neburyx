import { fileURLToPath } from 'node:url';
import { aiStatusResponseSchema, type AiMappingView, type AuditSink, type ExtensionLogger, type MountedAuditSink, type ProfileExtension } from '@neburyx/contracts';
import { createAuditSink } from '@neburyx/ee-audit';
import { createAnthropicProvider } from './anthropic.js';
import { createAuditedModelCall, type AuditedModelCall } from './audited.js';
import { configureAsk, type AskConfiguration } from './configure.js';
import { createFailureReporter } from './failure-line.js';
import { createPlanStore, type PlanStore } from './plans/index.js';
import { createPlanSweepTask } from './plans/sweep.js';
import { catalogWords, createAskPlanner } from './planner/index.js';
import { guardAiRouteGroup } from './route-guard.js';
import { createAskPlanRoute } from './routes/ask-plan.js';
import { createAskCancelRoute } from './routes/ask-cancel.js';
import { createAskEditRoute } from './routes/ask-edit.js';
import { createAskRunRoute } from './routes/ask-run.js';
import { createRequestBuilder, type RequestBuilder } from './request.js';
import { questionVocabulary } from './vocabulary/vocabulary.js';

export { AUDIT_ACTIONS, AuditUnavailableError, createAuditedModelCall } from './audited.js';
export type { AuditedCallContext, AuditedModelCall, AuditedModelOptions } from './audited.js';
export { ANTHROPIC_BASE_URL, createAnthropicProvider } from './anthropic.js';
export type { AnthropicProviderOptions, ProviderFailure } from './anthropic.js';
export { configureAsk } from './configure.js';
export { ROUTE_REFUSED_ACTION, guardAiRouteGroup } from './route-guard.js';
export { PII_OVERRIDE_EVENT, type PropertyRules } from './rules.js';
export { createRequestBuilder, piiPropertiesSentOf } from './request.js';
export type { BuiltRequest, ContextElement, RequestBuilder } from './request.js';
export type { AskConfiguration, KeyReference } from './configure.js';
export { BUILT_IN_PROMPTS, MAX_OVERRIDE_BYTES, PromptError, buildPromptRegistry } from './prompts.js';
export type { BuiltInPrompt, PromptRegistry, PromptRegistryResult, ResolvedPrompt } from './prompts.js';
export { FAILURE_CODES, PROMPT_IDS } from './provider.js';
export type { FailureCode, ModelAnswer, ModelProvider, ModelRequest, PromptId, PromptParameters, PromptRecord, PromptSource, TokenUsage } from './provider.js';

export { CATALOG, INVALID_PLAN_REASON, MODEL_REFUSED_REASON, PlannerCallFailed, catalogText, catalogWords, createAskPlanner, vocabularyText } from './planner/index.js';
export * from './plans/index.js';
export { PLAN_SWEEP_EVENT, PLAN_SWEEP_FAILED_EVENT, createPlanSweepTask } from './plans/sweep.js';
export { HydrationError, hydratePlan } from './plans/hydrate.js';
export type { HydrationFailure } from './plans/hydrate.js';
export { ASK_PLAN_URL, PLANNED_RATIONALE, askPlanRoute, createAskPlanRoute } from './routes/ask-plan.js';
export { questionVocabulary };
export { ASK_RUN_ACTION, ASK_RUN_URL, askRunRoute, createAskRunRoute } from './routes/ask-run.js';
export { paramsHashOf } from './plans/params-hash.js';
export { summarizeRun } from './plans/run-summary.js';
export type { RunSummary } from './plans/run-summary.js';
export { ASK_EDIT_URL, EDITED_RATIONALE, askEditRoute, createAskEditRoute } from './routes/ask-edit.js';
export { ASK_CANCEL_URL, askCancelRoute, createAskCancelRoute } from './routes/ask-cancel.js';
export { refusalOfPlan } from './plans/refusals.js';
export { editedParams } from './plans/edit-params.js';

export const AI_STATUS_URL = '/v1/ai/status';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../migrations', import.meta.url));

export interface EnterpriseExtension extends ProfileExtension {
  readonly configuration: () => AskConfiguration | undefined;
  /** The audit sink the application mounted, or undefined before it was built; the audited model call records through it. */
  readonly auditSink: () => AuditSink | undefined;
  /** The store of plans, built together with the audit sink on the same database login and ended with it; undefined before then. */
  readonly planStore: () => PlanStore | undefined;
  readonly requestBuilder: () => RequestBuilder | undefined;
  /** The model behind the audit: undefined until both the configuration and the mounted audit sink exist, so no route reaches the provider without the audit. */
  readonly model: () => AuditedModelCall | undefined;
}

export interface EnterpriseExtensionOptions {
  /** Only a test sets this, to a stub on the loopback address; the model client otherwise calls the service. */
  readonly modelBaseUrl?: string;
  /** Only a test sets this, to a store used in place of the one built with the audit sink on the application's database login. */
  readonly planStore?: PlanStore;
}

export function createEnterpriseExtension(options: EnterpriseExtensionOptions = {}): EnterpriseExtension {
  let configuration: AskConfiguration | undefined;
  let environment: Readonly<Record<string, string | undefined>> = {};
  let mounted: MountedAuditSink | undefined;
  let plans: PlanStore | undefined;
  let logger: ExtensionLogger | undefined;
  let mappingView: AiMappingView | undefined;
  const reportFailure = createFailureReporter(() => logger);
  return {
    name: 'ask',
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    attachLogger(attached) {
      logger = attached;
    },
    configuration: () => configuration,
    requestBuilder: () => (configuration === undefined ? undefined : createRequestBuilder(configuration.rules)),
    async configure(settings, env, view) {
      mappingView = view;
      const configured = await configureAsk(settings, env, view);
      configuration = configured.configuration;
      environment = env;
      return configured.outcome;
    },
    maintenanceTasks: () => (plans === undefined ? [] : [createPlanSweepTask(plans, () => logger)]),
    auditSink: () => mounted?.sink,
    planStore: () => options.planStore ?? plans,
    askPlanner() {
      const model = this.model();
      const requestBuilder = this.requestBuilder();
      return model === undefined || requestBuilder === undefined ? undefined : createAskPlanner({ model, requestBuilder, view: mappingView });
    },
    model: () => (configuration === undefined || mounted === undefined ? undefined : createAuditedModelCall({ provider: createAnthropicProvider({ configuration, env: environment, baseUrl: options.modelBaseUrl, onFailure: reportFailure }), configuration, sink: mounted.sink })),
    createAuditSink(context) {
      const audit = createAuditSink(context);
      const store = createPlanStore(context);
      mounted = audit;
      plans = store;
      // one close ends both pools, and a failure to end one does not leave the other open
      let closing: Promise<void> | undefined;
      return { sink: audit.sink, close: () => (closing ??= Promise.allSettled([audit.close(), store.close()]).then((results) => {
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      })) };
    },
    routeGroups: [
      guardAiRouteGroup({
        routes: [
          {
            method: 'GET',
            url: AI_STATUS_URL,
            permission: 'principal',
            responseSchema: aiStatusResponseSchema,
            handler: async () => ({ preview: true }),
          },
          createAskPlanRoute({ vocabulary: () => questionVocabulary({ view: mappingView, catalogWords: catalogWords() }), view: () => mappingView, plans: () => options.planStore ?? plans }),
          createAskRunRoute({ plans: () => options.planStore ?? plans, logger: () => logger }),
          createAskEditRoute({ plans: () => options.planStore ?? plans, view: () => mappingView }),
          createAskCancelRoute({ plans: () => options.planStore ?? plans }),
        ],
      }),
    ],
  };
}
