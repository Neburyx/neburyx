import { fileURLToPath } from 'node:url';
import { aiStatusResponseSchema, type AskClassifier, type AskFolder, type CaseSummarizer, type AuditSink, type AuditSinkContext, type ExtensionLogger, type MountedAuditSink, type ProfileExtension } from '@neburyx/contracts';
import { createAuditSink } from '@neburyx/ee-audit';
import { createAnthropicProvider } from './anthropic.js';
import { createAuditedModelCall, type AuditedModelCall } from './audited.js';
import { configureAsk, type AskConfiguration } from './configure.js';
import { createAskClassifier } from './classify/classifier.js';
import { createFailureReporter } from './failure-line.js';
import { createAskContinueRoute, createAskQuestionRoute } from './questions/question-routes.js';
import { createPgRunStore } from './questions/pg-run-store.js';
import type { RunStore } from './questions/run-store.js';
import { createPgSummaryRunStore, type SummaryRunStore } from './case-summary/run-store.js';
import { createCaseSummarizer } from './case-summary/summarizer.js';
import { summaryProviderConfiguration } from './case-summary/provider-configuration.js';
import { readTokenKeys } from './case-summary/token-keys.js';
import type { TokenKeys } from './case-summary/token-keys.js';
import { createSummaryRoute } from './case-summary/summary-route.js';
import { loadSummaryInstructions } from './case-summary/load-instructions.js';
import type { SummaryInstructions } from './case-summary/instructions.js';
import { readSummarySettings, summaryAvailability, type SummaryAvailability, type SummarySettings } from './case-summary/settings.js';
import { loadAskFolder } from './folder/load.js';
import { guardAiRouteGroup } from './route-guard.js';

/** @public Used by the audited-call integration test of `services/api`, which needs the real audit sink of the application and a real Postgres, so it cannot go through `createEnterpriseExtension()`. */
export { AuditUnavailableError, createAuditedModelCall } from './audited.js';
/** @public The type of the context an audited call carries: the audited-call integration test of `services/api` builds one for the real audit sink, as for `createAuditedModelCall` above. */
export type { AuditedCallContext } from './audited.js';
/** @public Used by the Neo4j demo-chain test of `services/api`, which checks the citations of the answers of the real application with the product's own check. */
export { citedKeysExist, listedElements } from './summary/index.js';
/** @public Used by the fuzz rig of `services/api`, which mounts the summary route beside the other routes of the application. */
export { createSummaryRoute } from './case-summary/summary-route.js';
/** @public Used by the preview-guard test of `services/api`, which mounts the guard on the real application beside the other route groups. */
export { ROUTE_REFUSED_ACTION, guardAiRouteGroup } from './route-guard.js';
/** @public Used by the completed-route test of `services/api`, which builds the case summarizer of the extension over a stub provider and the real application. */
export { createCaseSummarizer } from './case-summary/summarizer.js';
/** @public Test hooks: the services/api tests build a case summarizer with the in-memory store, and the integration test runs the real store on a Postgres. */
export { createMemorySummaryRunStore, createPgSummaryRunStore } from './case-summary/run-store.js';
/** @public The instructions of that test. */
export { buildSummaryInstructions } from './case-summary/instructions.js';
/** @public Opens a summary token for the copy to notes and the export that follow, and for the tests of the token. */
export { openToken } from './case-summary/token.js';
/** @public The prompt record of a request, which a stub provider of the completed-route test stamps on its answers. */
export { promptRecordOf } from './provider.js';
/** @public The types of a stub provider. */
export type { ModelAnswer, ModelProvider } from './provider.js';
/** @public The type of a request to the model: the audited-call integration test of `services/api` builds one, and the application of `services/api` is what gives it a real audit sink. */
export type { ModelRequest } from './provider.js';

const AI_STATUS_URL = '/v1/ai/status';
const MILLISECONDS_A_DAY = 24 * 60 * 60 * 1000;
/** How often the removal of old case summary records runs (the retention is in days, so an hour is fine). */
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../migrations', import.meta.url));

/** @public The type `services/api/src/testing/demo-packs.ts` returns from `createEnterpriseExtension()`: without the export its typecheck fails with TS4058, the name cannot be written in the declaration of that exported helper. */
export interface EnterpriseExtension extends ProfileExtension {
  /** The Ask folder read at start-up; undefined before `configure` accepted it. */
  readonly askFolder: () => AskFolder | undefined;
  /** The instructions of a summary call, built at start-up; undefined before `configure` accepted them. */
  readonly summaryInstructions: () => SummaryInstructions | undefined;
  /** The summary settings read at start-up; undefined before `configure` accepted them. */
  readonly summarySettings: () => SummarySettings | undefined;
  /** Whether a summary can be drafted now: Ask is configured and the settings, with a size guard, are in. */
  readonly summaryAvailability: () => SummaryAvailability;
  readonly configuration: () => AskConfiguration | undefined;
  /** The classifier of Ask, once the model is configured, the audit sink is mounted and the folder is loaded; undefined before. */
  readonly askClassifier: () => AskClassifier | undefined;
  /** The audit sink the application mounted, or undefined before it was built; the audited model call records through it. */
  readonly auditSink: () => AuditSink | undefined;
  /** The model behind the audit: undefined until both the configuration and the mounted audit sink exist, so no route reaches the provider without the audit. */
  readonly model: () => AuditedModelCall | undefined;
}

interface EnterpriseExtensionOptions {
  /** Only a test sets this, to a stub on the loopback address; the model client otherwise calls the service. */
  readonly modelBaseUrl?: string;
  /** Only a test sets this: the clock of the summary's time limit and of its retention. */
  readonly now?: () => number;
  /** Only a test sets this, to a store that opens no connection; the record of the case summary otherwise uses a pool of its own. */
  readonly summaryRunStore?: (context: AuditSinkContext) => SummaryRunStore;
  /** Only a test sets this: how often the removal of old records runs, in milliseconds. */
  readonly retentionIntervalMs?: number;
  /** Only a test sets this, to a folder that stands in for the summary files shipped with the product. */
  readonly shippedSummaryDirectory?: string;
  /** Only a test sets this, to a store that opens no connection; the run store otherwise writes `ask_runs` on a pool of its own. */
  readonly runStore?: (context: AuditSinkContext) => RunStore & { close(): Promise<void> };
}

export function createEnterpriseExtension(options: EnterpriseExtensionOptions = {}): EnterpriseExtension {
  let configuration: AskConfiguration | undefined;
  let environment: Readonly<Record<string, string | undefined>> = {};
  let mounted: MountedAuditSink | undefined;
  let logger: ExtensionLogger | undefined;
  let folder: AskFolder | undefined;
  let instructions: SummaryInstructions | undefined;
  let summarySettings: SummarySettings | undefined;
  let tokenKeys: TokenKeys | undefined;
  let summaryRuns: SummaryRunStore | undefined;
  let retentionTimer: ReturnType<typeof setInterval> | undefined;
  let runs: RunStore | undefined;
  const reportFailure = createFailureReporter(() => logger);
  const summaryModelOf = (): AuditedModelCall | undefined => {
    if (configuration === undefined || mounted === undefined || summarySettings === undefined) return undefined;
    const own = summaryProviderConfiguration(configuration, summarySettings);
    return createAuditedModelCall({ provider: createAnthropicProvider({ configuration: own, env: environment, ...(options.modelBaseUrl === undefined ? {} : { baseUrl: options.modelBaseUrl }) }), configuration: own, sink: mounted.sink });
  };
  const caseSummarizer = (): CaseSummarizer | undefined =>
    summarySettings === undefined || instructions === undefined ? undefined : createCaseSummarizer({ settings: summarySettings, instructions, model: summaryModelOf, audit: () => mounted?.sink, tokenKeys: () => tokenKeys, runs: () => summaryRuns, availability: () => summaryAvailability({ askConfigured: configuration !== undefined && instructions !== undefined, settings: summarySettings, tokenKeyConfigured: tokenKeys !== undefined }), ...(options.now === undefined ? {} : { now: options.now }) });
  const askClassifier = (): AskClassifier | undefined => {
    const model = modelOf();
    return model === undefined || folder === undefined ? undefined : createAskClassifier({ model, folder: () => folder });
  };
  const modelOf = (): AuditedModelCall | undefined => (configuration === undefined || mounted === undefined ? undefined : createAuditedModelCall({ provider: createAnthropicProvider({ configuration, env: environment, baseUrl: options.modelBaseUrl, onFailure: reportFailure }), configuration, sink: mounted.sink }));
  return {
    name: 'ask',
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    attachLogger(attached) {
      logger = attached;
    },
    configuration: () => configuration,
    askFolder: () => folder,
    summaryInstructions: () => instructions,
    summarySettings: () => summarySettings,
    summaryAvailability: () => summaryAvailability({ askConfigured: configuration !== undefined && instructions !== undefined, settings: summarySettings, tokenKeyConfigured: tokenKeys !== undefined }),
    askClassifier,
    caseSummarizer,
    async configure(_settings, env, context) {
      const configured = await configureAsk(env);
      configuration = configured.configuration;
      environment = env;
      if (!configured.outcome.ok || configured.configuration === undefined) return configured.outcome;
      const loaded = await loadAskFolder({ folder: configured.configuration.mappingFolder, sourceIds: context.sourceIds, ...(context.budgets === undefined ? {} : { budgets: context.budgets }) });
      if (!loaded.ok) {
        configuration = undefined;
        return { ok: false, problems: loaded.problems };
      }
      const settings = readSummarySettings(env);
      if (!settings.ok) {
        configuration = undefined;
        return { ok: false, problems: settings.problems };
      }
      const keys = await readTokenKeys(env);
      if (!keys.ok) {
        configuration = undefined;
        return { ok: false, problems: keys.problems };
      }
      const summary = await loadSummaryInstructions({ env, ...(options.shippedSummaryDirectory === undefined ? {} : { shippedDirectory: options.shippedSummaryDirectory }) });
      if (!summary.ok) {
        configuration = undefined;
        return { ok: false, problems: summary.problems };
      }
      folder = loaded.folder;
      instructions = summary.instructions;
      summarySettings = settings.settings;
      tokenKeys = keys.keys;
      return configured.outcome;
    },
    auditSink: () => mounted?.sink,
    model: modelOf,
    createAuditSink(context) {
      const audit = createAuditSink(context);
      const store = (options.runStore ?? createPgRunStore)(context);
      mounted = audit;
      runs = store;
      const summaryStore = (options.summaryRunStore ?? createPgSummaryRunStore)(context);
      summaryRuns = summaryStore;
      const removeOld = (): void => {
        if (summarySettings === undefined) return;
        const cutoff = new Date((options.now ?? Date.now)() - summarySettings.retentionDays * MILLISECONDS_A_DAY);
        summaryStore.removeStartedBefore(cutoff).catch(() => logger?.warn({ event: 'summary-runs.removal_failed' }, 'the removal of old case summary records failed'));
      };
      removeOld();
      retentionTimer = setInterval(removeOld, options.retentionIntervalMs ?? RETENTION_INTERVAL_MS);
      retentionTimer.unref();
      // one close ends both pools, and a failure to end one does not leave the other open
      let closing: Promise<void> | undefined;
      return {
        sink: audit.sink,
        close: () =>
          (closing ??= (retentionTimer === undefined ? undefined : clearInterval(retentionTimer), Promise.allSettled([audit.close(), store.close(), summaryStore.close()]).then((results) => {
            const failed = results.find((result) => result.status === 'rejected');
            if (failed?.status === 'rejected') throw failed.reason;
          }))),
      };
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
          createAskQuestionRoute({ folder: () => folder, runs: () => runs, logger: () => logger }),
          createAskContinueRoute({ folder: () => folder, runs: () => runs, logger: () => logger }),
          createSummaryRoute(),
        ],
      }),
    ],
  };
}
