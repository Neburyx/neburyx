import { fileURLToPath } from 'node:url';
import { aiStatusResponseSchema, type AskClassifier, type AskFolder, type AuditSink, type AuditSinkContext, type ExtensionLogger, type MountedAuditSink, type ProfileExtension } from '@neburyx/contracts';
import { createAuditSink } from '@neburyx/ee-audit';
import { createAnthropicProvider } from './anthropic.js';
import { createAuditedModelCall, type AuditedModelCall } from './audited.js';
import { configureAsk, type AskConfiguration } from './configure.js';
import { createAskClassifier } from './classify/classifier.js';
import { createFailureReporter } from './failure-line.js';
import { createAskContinueRoute, createAskQuestionRoute } from './questions/question-routes.js';
import { createPgRunStore } from './questions/pg-run-store.js';
import type { RunStore } from './questions/run-store.js';
import { loadAskFolder } from './folder/load.js';
import { guardAiRouteGroup } from './route-guard.js';

/** @public Used by the audited-call integration test of `services/api`, which needs the real audit sink of the application and a real Postgres, so it cannot go through `createEnterpriseExtension()`. */
export { AuditUnavailableError, createAuditedModelCall } from './audited.js';
/** @public The type of the context an audited call carries: the audited-call integration test of `services/api` builds one for the real audit sink, as for `createAuditedModelCall` above. */
export type { AuditedCallContext } from './audited.js';
/** @public Used by the Neo4j demo-chain test of `services/api`, which checks the citations of the answers of the real application with the product's own check. */
export { citedKeysExist, listedElements } from './summary/index.js';
/** @public Used by the preview-guard test of `services/api`, which mounts the guard on the real application beside the other route groups. */
export { ROUTE_REFUSED_ACTION, guardAiRouteGroup } from './route-guard.js';
/** @public The type of a request to the model: the audited-call integration test of `services/api` builds one, and the application of `services/api` is what gives it a real audit sink. */
export type { ModelRequest } from './provider.js';

const AI_STATUS_URL = '/v1/ai/status';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../migrations', import.meta.url));

/** @public The type `services/api/src/testing/demo-packs.ts` returns from `createEnterpriseExtension()`: without the export its typecheck fails with TS4058, the name cannot be written in the declaration of that exported helper. */
export interface EnterpriseExtension extends ProfileExtension {
  /** The Ask folder read at start-up; undefined before `configure` accepted it. */
  readonly askFolder: () => AskFolder | undefined;
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
  /** Only a test sets this, to a store that opens no connection; the run store otherwise writes `ask_runs` on a pool of its own. */
  readonly runStore?: (context: AuditSinkContext) => RunStore & { close(): Promise<void> };
}

export function createEnterpriseExtension(options: EnterpriseExtensionOptions = {}): EnterpriseExtension {
  let configuration: AskConfiguration | undefined;
  let environment: Readonly<Record<string, string | undefined>> = {};
  let mounted: MountedAuditSink | undefined;
  let logger: ExtensionLogger | undefined;
  let folder: AskFolder | undefined;
  let runs: RunStore | undefined;
  const reportFailure = createFailureReporter(() => logger);
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
    askClassifier,
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
      folder = loaded.folder;
      return configured.outcome;
    },
    auditSink: () => mounted?.sink,
    model: modelOf,
    createAuditSink(context) {
      const audit = createAuditSink(context);
      const store = (options.runStore ?? createPgRunStore)(context);
      mounted = audit;
      runs = store;
      // one close ends both pools, and a failure to end one does not leave the other open
      let closing: Promise<void> | undefined;
      return {
        sink: audit.sink,
        close: () =>
          (closing ??= Promise.allSettled([audit.close(), store.close()]).then((results) => {
            const failed = results.find((result) => result.status === 'rejected');
            if (failed?.status === 'rejected') throw failed.reason;
          })),
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
        ],
      }),
    ],
  };
}
