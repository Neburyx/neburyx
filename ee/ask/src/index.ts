import { fileURLToPath } from 'node:url';
import { aiStatusResponseSchema, type AskClassifier, type AskFolder, type AuditSink, type ExtensionLogger, type MountedAuditSink, type ProfileExtension } from '@neburyx/contracts';
import { createAuditSink } from '@neburyx/ee-audit';
import { createAnthropicProvider } from './anthropic.js';
import { createAuditedModelCall, type AuditedModelCall } from './audited.js';
import { configureAsk, type AskConfiguration } from './configure.js';
import { createAskClassifier } from './classify/classifier.js';
import { createFailureReporter } from './failure-line.js';
import { loadAskFolder } from './folder/load.js';
import { guardAiRouteGroup } from './route-guard.js';

export { AuditUnavailableError, createAuditedModelCall } from './audited.js';
export type { AuditedCallContext } from './audited.js';
export { configureAsk } from './configure.js';
export { ROUTE_REFUSED_ACTION, guardAiRouteGroup } from './route-guard.js';
export { FAILURE_CODES, promptRecordOf } from './provider.js';
export type { FailureCode, ModelAnswer, ModelProvider, ModelRequest, TokenUsage } from './provider.js';

export const AI_STATUS_URL = '/v1/ai/status';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../migrations', import.meta.url));

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

export interface EnterpriseExtensionOptions {
  /** Only a test sets this, to a stub on the loopback address; the model client otherwise calls the service. */
  readonly modelBaseUrl?: string;
}

export function createEnterpriseExtension(options: EnterpriseExtensionOptions = {}): EnterpriseExtension {
  let configuration: AskConfiguration | undefined;
  let environment: Readonly<Record<string, string | undefined>> = {};
  let mounted: MountedAuditSink | undefined;
  let logger: ExtensionLogger | undefined;
  let folder: AskFolder | undefined;
  const reportFailure = createFailureReporter(() => logger);
  const modelOf = (): AuditedModelCall | undefined => (configuration === undefined || mounted === undefined ? undefined : createAuditedModelCall({ provider: createAnthropicProvider({ configuration, env: environment, baseUrl: options.modelBaseUrl, onFailure: reportFailure }), configuration, sink: mounted.sink }));
  return {
    name: 'ask',
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    attachLogger(attached) {
      logger = attached;
    },
    configuration: () => configuration,
    askFolder: () => folder,
    askClassifier: () => {
      const model = modelOf();
      return model === undefined || folder === undefined ? undefined : createAskClassifier({ model, folder: () => folder });
    },
    async configure(_settings, env, context) {
      const configured = await configureAsk(env);
      configuration = configured.configuration;
      environment = env;
      if (!configured.outcome.ok || configured.configuration === undefined) return configured.outcome;
      const loaded = await loadAskFolder({ folder: configured.configuration.mappingFolder, sourceIds: context.sourceIds });
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
      mounted = createAuditSink(context);
      return mounted;
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
        ],
      }),
    ],
  };
}
