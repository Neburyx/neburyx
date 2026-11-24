import { fileURLToPath } from 'node:url';
import { SUMMARY_DEFAULTS, THREAD_READ_TURNS_DEFAULT, type AskClassifier, type ConfigureContext, type ConfigureOutcome, type ConfigureWarning, type AskFolder, type CaseSummarizer, type AuditSink, type AuditSinkContext, type ExtensionLogger, type MountedAuditSink, type ProfileExtension, type RecordQueue } from '@neburyx/contracts';
import { createAnthropicProvider, createAuditedModelCall, createCallRecorder, createCheckRunner, createFailureReporter, configureProvider, featureSwitches, type AiFeatureSwitches, type AuditedModelCall, type ProviderConfiguration } from '@neburyx/ee-ai-runtime';
import { createAuditSink } from '@neburyx/ee-audit';
import { configureAsk, optionalFolderChoice, type AskConfiguration } from './configure.js';
import { createAskClassifier } from './classify/classifier.js';
import { createAskContinueRoute, createAskQuestionRoute } from './questions/question-routes.js';
import { createPgRunStore } from './questions/pg-run-store.js';
import { queuedRunStore } from './questions/queued-run-store.js';
import type { RunStore } from './questions/run-store.js';
import { queuedSummaryRunStore } from './case-summary/queued-run-store.js';
import { createPgSummaryRunStore, type SummaryRunStore } from './case-summary/run-store.js';
import { queuedAssistantRunStore } from './assistant/queued-run-store.js';
import { createPgAssistantRunStore, type AssistantRunStore } from './assistant/run-store.js';
import { createPgAssistantThreadStore, type AssistantThreadStore } from './assistant/thread-store.js';
import { createPgAssistantPendingStore, type AssistantPendingStore } from './assistant/pending-store.js';
import { createAssistantThreadRoute } from './assistant/thread-route.js';
import { createCaseSummarizer } from './case-summary/summarizer.js';
import { summaryProviderConfiguration } from './case-summary/provider-configuration.js';
import { readTokenKeys } from './case-summary/token-keys.js';
import type { TokenKeys } from './case-summary/token-keys.js';
import { createCopyToNotesRoute } from './case-summary/copy-route.js';
import { createReadAiNotesRoute } from './case-summary/notes-read-route.js';
import { createSummaryRoute } from './case-summary/summary-route.js';
import { loadSummaryInstructions } from './case-summary/load-instructions.js';
import type { SummaryInstructions } from './case-summary/instructions.js';
import { readSummarySettings, summaryAvailability, type SummaryAvailability, type SummarySettings } from './case-summary/settings.js';
import { loadAskFolder } from './folder/load.js';
import type { AssistantInstructions } from './assistant/instructions.js';
import { loadAssistantInstructions } from './assistant/load-instructions.js';
import { readAssistantSettings, rowsAllowed, type AssistantSettings } from './assistant/settings.js';
import { guardAiRouteGroup } from './route-guard.js';
import { assistantProviderConfiguration } from './assistant/provider-configuration.js';
import { createAssistantRouter } from './assistant/router.js';
import { createViewAnswer } from './assistant/view-answer.js';
import { AGENT_PROMPT_ID, AGENT_PROMPT_VERSION, createAgentTurn } from './assistant/agent-turn.js';
import { createAnthropicChatModel } from '@neburyx/ee-assistant-agent';
import { loadViewInstructions, type ViewInstructions } from './assistant/view-instructions.js';
import { loadOverviewInstructions, type OverviewInstructions } from './assistant/overview-instructions.js';
import { OVERVIEW_AUDIT_ACTION, OVERVIEW_PROMPT_ID, OVERVIEW_PROMPT_VERSION } from './assistant/verdict-overview.js';
import { createAssistantTurnRoute } from './assistant/turn-route.js';
import { withheldDescriptionWarnings } from './assistant/description-warnings.js';

/** @public Used by the audited-call integration test of `services/api`, which needs the real audit sink of the application and a real Postgres, so it cannot go through `createEnterpriseExtension()`. */
export { AuditUnavailableError, createAuditedModelCall } from '@neburyx/ee-ai-runtime';
/** @public The type of the context an audited call carries: the audited-call integration test of `services/api` builds one for the real audit sink, as for `createAuditedModelCall` above. */
export type { AuditedCallContext } from '@neburyx/ee-ai-runtime';
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
/** @public Test hooks, as for the summary: the services/api tests build the assistant with the in-memory store, and the integration test runs the real store on a Postgres. */
export { createMemoryAssistantRunStore, createPgAssistantRunStore } from './assistant/run-store.js';
/** @public Test hooks for the threads of the assistant: the services/api tests run the real store on a Postgres and build the assistant with the in-memory one. */
export { createMemoryAssistantThreadStore, createPgAssistantThreadStore, type AssistantThreadStore } from './assistant/thread-store.js';
/** @public Test hooks for the confirmations that wait for the analyst: the services/api tests and the suites build the assistant with the in-memory store, and the integration test runs the real store on a Postgres. */
export { createMemoryAssistantPendingStore, createPgAssistantPendingStore, type AssistantPendingStore, type MemoryAssistantPendingStore } from './assistant/pending-store.js';
/** @public The instructions of that test. */
export { buildSummaryInstructions } from './case-summary/instructions.js';
/** @public Opens a summary token for the copy to notes and the export that follow, and for the tests of the token. */
export { openToken, sealToken } from './case-summary/token.js';
/** @public The summary section of an export for a token, for the tests of `services/api` that give an export the real renderer with a sealing key of their own. */
export { renderForExport } from './case-summary/export-render.js';
/** @public The routes of the AI notes, for the tests that mount them with a sealing key of their own. */
export { createCopyToNotesRoute } from './case-summary/copy-route.js';
/** @public */
export { createReadAiNotesRoute } from './case-summary/notes-read-route.js';
/** @public The prompt record of a request, which a stub provider of the completed-route test stamps on its answers. */
export { promptRecordOf } from '@neburyx/ee-ai-runtime';
/** @public The types of a stub provider. */
export type { ModelAnswer, ModelProvider } from '@neburyx/ee-ai-runtime';
/** @public The type of a request to the model: the audited-call integration test of `services/api` builds one, and the application of `services/api` is what gives it a real audit sink. */
export type { ModelRequest } from '@neburyx/ee-ai-runtime';

const MILLISECONDS_A_DAY = 24 * 60 * 60 * 1000;
/** How often the removal of old case summary records runs (the retention is in days, so an hour is fine). */
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../migrations', import.meta.url));

/** @public The type `services/api/src/testing/demo-packs.ts` returns from `createEnterpriseExtension()`: without the export its typecheck fails with TS4058, the name cannot be written in the declaration of that exported helper. */
export interface EnterpriseExtension extends ProfileExtension {
  /** The Ask folder read at start-up; undefined before `configure` accepted it. */
  readonly askFolder: () => AskFolder | undefined;
  /** The instructions of a summary call, built at start-up; undefined before `configure` accepted them. */
  readonly summaryInstructions: (sourceId: string) => SummaryInstructions | undefined;
  /** The assistant's settings read at start-up; undefined before `configure` accepted them and while the assistant is off. */
  readonly assistantSettings: () => AssistantSettings | undefined;
  /** The assistant's instructions, with their hash; undefined before `configure` accepted them and while the assistant is off. */
  readonly assistantInstructions: () => AssistantInstructions | undefined;
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
  /** Only a test sets this: the store of the assistant turns' records. */
  readonly assistantRunStore?: (context: AuditSinkContext) => AssistantRunStore;
  /** Only a test sets this: the store of the assistant's threads. */
  readonly assistantThreadStore?: (context: AuditSinkContext) => AssistantThreadStore;
  readonly assistantPendingStore?: (context: AuditSinkContext) => AssistantPendingStore;
  /** Only a test sets this: how often the removal of old records runs, in milliseconds. */
  readonly retentionIntervalMs?: number;
  /** Only a test sets this, to a folder that stands in for the summary files shipped with the product. */
  readonly shippedSummaryDirectory?: string;
  /** Only a test sets this, to a folder that stands in for the assistant file shipped with the product. */
  readonly shippedAssistantDirectory?: string;
  /** Only a test sets this, to a store that opens no connection; the run store otherwise writes `ask_runs` on a pool of its own. */
  readonly runStore?: (context: AuditSinkContext) => RunStore & { close(): Promise<void> };
  /** The features that are off; each is on unless named. Only a test sets this until the settings that turn a feature off exist. */
  readonly features?: Partial<AiFeatureSwitches>;
}

export function createEnterpriseExtension(options: EnterpriseExtensionOptions = {}): EnterpriseExtension {
  let features = featureSwitches(options.features);
  const checks = createCheckRunner();
  let configuration: AskConfiguration | undefined;
  let provider: ProviderConfiguration | undefined;
  let environment: Readonly<Record<string, string | undefined>> = {};
  let mounted: MountedAuditSink | undefined;
  let queuedAudit: AuditSink | undefined;
  let recordQueue: RecordQueue | undefined;
  const auditOf = (): AuditSink | undefined => queuedAudit ?? mounted?.sink;
  let logger: ExtensionLogger | undefined;
  let folder: AskFolder | undefined;
  /** The instructions of a summary for a source: the prompt and the typology of the operator's file or else of the source's own Ask folder. */
  let instructions: ((sourceId: string) => SummaryInstructions) | undefined;
  let summarySettings: SummarySettings | undefined;
  let assistantSettings: AssistantSettings | undefined;
  let sourceBudgets: ConfigureContext['budgets'];
  let assistantInstructions: AssistantInstructions | undefined;
  let viewInstructions: ((sourceId: string) => ViewInstructions) | undefined;
  let overviewInstructions: OverviewInstructions | undefined;
  let typologyLines: (sourceId: string) => readonly string[] = () => [];
  let tokenKeys: TokenKeys | undefined;
  let summaryRuns: SummaryRunStore | undefined;
  let assistantRuns: AssistantRunStore | undefined;
  let assistantThreads: AssistantThreadStore | undefined;
  let assistantPending: AssistantPendingStore | undefined;
  let retentionTimer: ReturnType<typeof setInterval> | undefined;
  let runs: RunStore | undefined;
  const reportFailure = createFailureReporter(() => logger);
  const summaryModelOf = (): AuditedModelCall | undefined => {
    if (provider === undefined || mounted === undefined || summarySettings === undefined) return undefined;
    const own = summaryProviderConfiguration(provider, summarySettings);
    return createAuditedModelCall({ provider: createAnthropicProvider({ configuration: own, env: environment, ...(options.modelBaseUrl === undefined ? {} : { baseUrl: options.modelBaseUrl }) }), configuration: own, sink: queuedAudit ?? mounted.sink });
  };
  const caseSummarizer = (): CaseSummarizer | undefined =>
    !features.summary || summarySettings === undefined || instructions === undefined ? undefined : createCaseSummarizer({ settings: summarySettings, instructions, checks, onCheckRefused: (reason) => logger?.warn({ event: 'summary.check_refused', reason }, 'a check of a summary reply could not run'), model: summaryModelOf, audit: auditOf, tokenKeys: () => tokenKeys, runs: () => summaryRuns, availability: () => summaryAvailability({ askConfigured: provider !== undefined && instructions !== undefined, settings: summarySettings, tokenKeyConfigured: tokenKeys !== undefined }), ...(options.now === undefined ? {} : { now: options.now }) });
  const askClassifier = (): AskClassifier | undefined => {
    const model = modelOf();
    return !features.ask || model === undefined || folder === undefined ? undefined : createAskClassifier({ model, folder: () => folder });
  };
  const modelOf = (): AuditedModelCall | undefined => (configuration === undefined || mounted === undefined ? undefined : createAuditedModelCall({ provider: createAnthropicProvider({ configuration, env: environment, baseUrl: options.modelBaseUrl, onFailure: reportFailure }), configuration, sink: queuedAudit ?? mounted.sink }));
  const assistantModelOf = (): AuditedModelCall | undefined => {
    const sink = auditOf();
    if (provider === undefined || sink === undefined || assistantSettings === undefined) return undefined;
    const own = assistantProviderConfiguration(provider, assistantSettings);
    return createAuditedModelCall({ provider: createAnthropicProvider({ configuration: own, env: environment, ...(options.modelBaseUrl === undefined ? {} : { baseUrl: options.modelBaseUrl }) }), configuration: own, sink });
  };
  const assistantViewAnswer = (): ReturnType<typeof createViewAnswer> | undefined => {
    const model = assistantModelOf();
    const settings = assistantSettings;
    return !features.assistant || model === undefined || settings === undefined || viewInstructions === undefined ? undefined : createViewAnswer({ model, instructions: (sourceId) => viewInstructions?.(sourceId), checks, settings: () => ({ model: settings.model, maxInputTokens: settings.maxInputTokens, maxCalls: settings.maxCalls, timeoutMs: settings.timeoutMs, totalTimeoutMs: settings.totalTimeoutMs }), ...(options.now === undefined ? {} : { now: options.now }) });
  };
  /** The view's own path under the overview's prompt, for what a refusal of a verdict shows beside its fixed sentence. */
  const assistantOverview = (): ReturnType<typeof createViewAnswer> | undefined => {
    const model = assistantModelOf();
    const settings = assistantSettings;
    return !features.assistant || model === undefined || settings === undefined || overviewInstructions === undefined ? undefined : createViewAnswer({ model, prompt: { id: OVERVIEW_PROMPT_ID, version: OVERVIEW_PROMPT_VERSION, action: OVERVIEW_AUDIT_ACTION, connectionsOnly: true }, instructions: () => overviewInstructions, checks, settings: () => ({ model: settings.model, maxInputTokens: settings.maxInputTokens, maxCalls: settings.maxCalls, timeoutMs: settings.timeoutMs, totalTimeoutMs: settings.totalTimeoutMs }), ...(options.now === undefined ? {} : { now: options.now }) });
  };
  const assistantRouter = (): ReturnType<typeof createAssistantRouter> | undefined => {
    const model = assistantModelOf();
    const settings = assistantSettings;
    return !features.assistant || model === undefined || settings === undefined || assistantInstructions === undefined ? undefined : createAssistantRouter({ model, folder: () => folder, instructions: () => assistantInstructions, multiRead: () => settings.maxSteps >= 2, maxInputTokens: () => settings.maxInputTokens, maxCalls: () => settings.maxCalls });
  };
  const assistantAgentTurn = (): ReturnType<typeof createAgentTurn> | undefined => {
    const settings = assistantSettings;
    const sink = auditOf();
    if (!features.assistant || provider === undefined || sink === undefined || settings === undefined || viewInstructions === undefined) return undefined;
    const own = assistantProviderConfiguration(provider, settings);
    const recorder = createCallRecorder({ sink });
    return createAgentTurn({
      model: (context, trace) => createAnthropicChatModel({ configuration: own, env: environment, ...(options.modelBaseUrl === undefined ? {} : { baseUrl: options.modelBaseUrl }), hook: { recorder, context, promptId: AGENT_PROMPT_ID, promptVersion: AGENT_PROMPT_VERSION, modelRef: own.model, ...(trace === undefined ? {} : { trace }) } }),
      modelRef: () => own.model,
      instructions: (sourceId) => viewInstructions?.(sourceId),
      settings: (sourceId) => {
        const maxPage = sourceBudgets?.[sourceId]?.maxPage;
        const rows = maxPage === undefined ? settings.maxRows : rowsAllowed(settings, maxPage);
        return { maxCalls: settings.maxCalls, maxSteps: settings.maxSteps, maxInputTokens: settings.maxInputTokens, timeoutMs: settings.timeoutMs, ...(rows === undefined ? {} : { rowsAllowed: rows }) };
      },
      checks,
    });
  };
  const guarded = [
    guardAiRouteGroup({ routes: [createAssistantThreadRoute({ threads: () => assistantThreads, limit: () => assistantSettings?.threadReadTurns ?? THREAD_READ_TURNS_DEFAULT, logger: () => logger }), createAssistantTurnRoute({ router: assistantRouter, agentTurn: assistantAgentTurn, totalTimeoutMs: () => assistantSettings?.totalTimeoutMs, contextTurns: () => assistantSettings?.contextTurns, contextTextTokens: () => (assistantSettings?.contextText === true ? Math.floor(assistantSettings.maxInputTokens / 2) : undefined), typology: (sourceId) => typologyLines(sourceId), notesMaxRefs: () => summarySettings?.maxElements ?? SUMMARY_DEFAULTS.maxElements, summaryKeys: () => (features.summary ? tokenKeys : undefined), viewAnswer: assistantViewAnswer, overview: assistantOverview, runs: () => assistantRuns, runSettings: () => assistantSettings, threads: () => assistantThreads, pending: () => assistantPending, records: () => recordQueue, maxMessageWords: () => assistantSettings?.maxMessageWords, folder: () => folder, logger: () => logger, ...(options.now === undefined ? {} : { now: options.now }) })] }, () => features.assistant),
    guardAiRouteGroup({ routes: [createAskQuestionRoute({ folder: () => folder, runs: () => runs, logger: () => logger }), createAskContinueRoute({ folder: () => folder, runs: () => runs, logger: () => logger })] }, () => features.ask),
    guardAiRouteGroup(
      { routes: [createSummaryRoute(), createCopyToNotesRoute({ tokenKeys: () => tokenKeys }), createReadAiNotesRoute({ maxRefs: () => summarySettings?.maxElements ?? SUMMARY_DEFAULTS.maxElements })] },
      () => features.summary,
    ),
  ];
  return {
    name: 'ask',
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    attachLogger(attached) {
      logger = attached;
    },
    configuration: () => configuration,
    askFolder: () => folder,
    summaryInstructions: (sourceId) => instructions?.(sourceId),
    summarySettings: () => summarySettings,
    assistantSettings: () => assistantSettings,
    assistantInstructions: () => assistantInstructions,
    summaryAvailability: () => summaryAvailability({ askConfigured: configuration !== undefined && instructions !== undefined, settings: summarySettings, tokenKeyConfigured: tokenKeys !== undefined }),
    askClassifier,
    caseSummarizer,
    async configure(_settings, env, context) {
      environment = env;
      if (context.features !== undefined) features = featureSwitches(context.features);
      const askConfigured = features.ask ? await configureAsk(env) : undefined;
      const providerConfigured = askConfigured ?? (features.summary || features.assistant ? await configureProvider(env) : undefined);
      assistantSettings = undefined;
      assistantInstructions = undefined;
      viewInstructions = undefined;
      overviewInstructions = undefined;
      typologyLines = () => [];
      const assistant = features.assistant ? readAssistantSettings(env) : undefined;
      const assistantPrompt = features.assistant ? await loadAssistantInstructions({ env, ...(options.shippedAssistantDirectory === undefined ? {} : { shippedDirectory: options.shippedAssistantDirectory }) }) : undefined;
      const viewPrompt = features.assistant ? await loadViewInstructions({ env, ...(options.shippedAssistantDirectory === undefined ? {} : { shippedDirectory: options.shippedAssistantDirectory }) }) : undefined;
      const overviewPrompt = features.assistant ? await loadOverviewInstructions({ env, ...(options.shippedAssistantDirectory === undefined ? {} : { shippedDirectory: options.shippedAssistantDirectory }) }) : undefined;
      const assistantProblems = [...(assistant?.ok === false ? assistant.problems : []), ...(assistantPrompt?.ok === false ? assistantPrompt.problems : []), ...(viewPrompt?.ok === false ? viewPrompt.problems : []), ...(overviewPrompt?.ok === false ? overviewPrompt.problems : [])];
      if (assistantProblems.length > 0) return { ok: false, problems: assistantProblems };
      if (providerConfigured === undefined) return { ok: true };
      configuration = askConfigured?.configuration;
      provider = providerConfigured.configuration;
      if (!providerConfigured.outcome.ok || provider === undefined) return providerConfigured.outcome;
      const refuse = (problems: readonly string[]): ConfigureOutcome => {
        configuration = undefined;
        provider = undefined;
        return { ok: false, problems };
      };
      let loadedFolder: AskFolder | undefined;
      const warnings: ConfigureWarning[] = [];
      // the assistant's `ask` route reads the folder of intents when there is one; with Ask off the folder is optional
      const folderChoice = askConfigured?.configuration === undefined ? (features.assistant ? optionalFolderChoice(env) : undefined) : { folder: askConfigured.configuration.mappingFolder, problems: [] };
      if (folderChoice !== undefined && folderChoice.problems.length > 0) return refuse(folderChoice.problems);
      if (folderChoice?.folder !== undefined) {
        sourceBudgets = context.budgets;
        const loaded = await loadAskFolder({ folder: folderChoice.folder, sourceIds: context.sourceIds, ...(context.budgets === undefined ? {} : { budgets: context.budgets }) });
        if (loaded.ok) loadedFolder = loaded.folder;
        else if (features.ask) return refuse(loaded.problems);
        else warnings.push({ event: 'assistant.ask_folder_unavailable', message: 'the folder of Ask questions could not be used, so the assistant runs without it' });
      }
      if (features.assistant) warnings.push(...withheldDescriptionWarnings(context.typeDescriptions));
      let readSettings: SummarySettings | undefined;
      let readKeys: TokenKeys | undefined;
      let readInstructions: ((sourceId: string) => SummaryInstructions) | undefined;
      if (features.summary) {
        const settings = readSummarySettings(env);
        if (!settings.ok) return refuse(settings.problems);
        const keys = await readTokenKeys(env);
        if (!keys.ok) return refuse(keys.problems);
        const summary = await loadSummaryInstructions({ env, ...(options.shippedSummaryDirectory === undefined ? {} : { shippedDirectory: options.shippedSummaryDirectory }) });
        if (!summary.ok) return refuse(summary.problems);
        readSettings = settings.settings;
        readKeys = keys.keys;
        readInstructions = (sourceId) => summary.instructionsFor(loadedFolder?.source(sourceId)?.typology?.text ?? '');
      }
      assistantSettings = assistant?.ok === true ? assistant.settings : undefined;
      assistantInstructions = assistantPrompt?.ok === true ? assistantPrompt.instructions : undefined;
      viewInstructions = viewPrompt?.ok === true ? (sourceId) => viewPrompt.instructionsFor(loadedFolder?.source(sourceId)?.typology?.text ?? '') : undefined;
      overviewInstructions = overviewPrompt?.ok === true ? overviewPrompt.instructions : undefined;
      typologyLines = viewPrompt?.ok === true ? (sourceId) => viewPrompt.typologyFor(loadedFolder?.source(sourceId)?.typology?.text ?? '') : () => [];
      folder = loadedFolder;
      instructions = readInstructions;
      summarySettings = readSettings;
      tokenKeys = readKeys;
      return warnings.length === 0 ? providerConfigured.outcome : { ok: true, warnings };
    },
    auditSink: auditOf,
    attachAudit(sink) {
      queuedAudit = sink;
    },
    attachRecordQueue(queue) {
      recordQueue = queue;
    },
    model: modelOf,
    aiAvailability: () => ({ ask: { available: features.ask && askClassifier() !== undefined }, summary: { available: features.summary && caseSummarizer()?.availability().available === true }, assistant: assistantRouter() !== undefined && assistantSettings !== undefined ? { available: true, messageWords: assistantSettings.maxMessageWords } : { available: false } }),
    createAuditSink(context) {
      const audit = createAuditSink(context);
      mounted = audit;
      const store = features.ask ? (options.runStore ?? createPgRunStore)(context) : undefined;
      runs = store === undefined ? undefined : queuedRunStore(store, () => recordQueue);
      const summaryStore = features.summary ? (options.summaryRunStore ?? createPgSummaryRunStore)(context) : undefined;
      summaryRuns = summaryStore === undefined ? undefined : queuedSummaryRunStore(summaryStore, () => recordQueue);
      const assistantStore = features.assistant ? (options.assistantRunStore ?? createPgAssistantRunStore)(context) : undefined;
      assistantRuns = assistantStore === undefined ? undefined : queuedAssistantRunStore(assistantStore, () => recordQueue);
      assistantThreads = features.assistant ? (options.assistantThreadStore ?? createPgAssistantThreadStore)(context) : undefined;
      assistantPending = features.assistant ? (options.assistantPendingStore ?? createPgAssistantPendingStore)(context) : undefined;
      const removals: (() => void)[] = [];
      if (summaryStore !== undefined) {
        removals.push(() => {
          if (summarySettings === undefined) return;
          const cutoff = new Date((options.now ?? Date.now)() - summarySettings.retentionDays * MILLISECONDS_A_DAY);
          summaryStore.removeStartedBefore(cutoff).catch(() => logger?.warn({ event: 'summary-runs.removal_failed' }, 'the removal of old case summary records failed'));
        });
      }
      if (assistantStore !== undefined) {
        removals.push(() => {
          if (assistantSettings === undefined) return;
          const cutoff = new Date((options.now ?? Date.now)() - assistantSettings.runRetentionDays * MILLISECONDS_A_DAY);
          assistantStore.removeStartedBefore(cutoff).catch(() => logger?.warn({ event: 'assistant-runs.removal_failed' }, 'the removal of old assistant turn records failed'));
        });
      }
      if (removals.length > 0) {
        const removeOld = (): void => {
          for (const remove of removals) remove();
        };
        removeOld();
        retentionTimer = setInterval(removeOld, options.retentionIntervalMs ?? RETENTION_INTERVAL_MS);
        retentionTimer.unref();
      }
      // one close ends every pool, and a failure to end one does not leave the others open
      let closing: Promise<void> | undefined;
      return {
        sink: audit.sink,
        close: () =>
          (closing ??= (retentionTimer === undefined ? undefined : clearInterval(retentionTimer), Promise.allSettled([audit.close(), store?.close(), summaryStore?.close(), assistantStore?.close(), assistantThreads?.close(), assistantPending?.close()]).then((results) => {
            const failed = results.find((result) => result.status === 'rejected');
            if (failed?.status === 'rejected') throw failed.reason;
          }))),
      };
    },
    routeGroups: [{ routes: guarded.flatMap((group) => group.routes) }],
  };
}
