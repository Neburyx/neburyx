import { fileURLToPath } from 'node:url';
import { aiStatusResponseSchema, type AuditSink, type MountedAuditSink, type ProfileExtension } from '@neburyx/contracts';
import { createAuditSink } from '@neburyx/ee-audit';
import { createAnthropicProvider } from './anthropic.js';
import { createAuditedModelCall, type AuditedModelCall } from './audited.js';
import { configureAsk, type AskConfiguration } from './configure.js';
import { guardAiRouteGroup } from './route-guard.js';
import { createRequestBuilder, type RequestBuilder } from './request.js';

export { AUDIT_ACTIONS, AuditUnavailableError, createAuditedModelCall } from './audited.js';
export type { AuditedCallContext, AuditedModelCall, AuditedModelOptions } from './audited.js';
export { ANTHROPIC_BASE_URL, createAnthropicProvider } from './anthropic.js';
export type { AnthropicProviderOptions } from './anthropic.js';
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

export const AI_STATUS_URL = '/v1/ai/status';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../migrations', import.meta.url));

export interface EnterpriseExtension extends ProfileExtension {
  readonly configuration: () => AskConfiguration | undefined;
  /** The audit sink the application mounted, or undefined before it was built; the audited model call records through it. */
  readonly auditSink: () => AuditSink | undefined;
  readonly requestBuilder: () => RequestBuilder | undefined;
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
  return {
    name: 'ask',
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    configuration: () => configuration,
    requestBuilder: () => (configuration === undefined ? undefined : createRequestBuilder(configuration.rules)),
    async configure(settings, env, view) {
      const configured = await configureAsk(settings, env, view);
      configuration = configured.configuration;
      environment = env;
      return configured.outcome;
    },
    auditSink: () => mounted?.sink,
    model: () => (configuration === undefined || mounted === undefined ? undefined : createAuditedModelCall({ provider: createAnthropicProvider({ configuration, env: environment, baseUrl: options.modelBaseUrl }), configuration, sink: mounted.sink })),
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
