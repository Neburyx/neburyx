import { fileURLToPath } from 'node:url';
import { aiStatusResponseSchema, type ProfileExtension } from '@neburyx/contracts';
import { createAuditSink } from '@neburyx/ee-audit';
import { configureAsk, type AskConfiguration } from './configure.js';

export { configureAsk } from './configure.js';
export type { AskConfiguration, KeyReference } from './configure.js';
export { BUILT_IN_PROMPTS, MAX_OVERRIDE_BYTES, PromptError, buildPromptRegistry } from './prompts.js';
export type { BuiltInPrompt, PromptRegistry, PromptRegistryResult, ResolvedPrompt } from './prompts.js';
export { FAILURE_CODES, PROMPT_IDS } from './provider.js';
export type { FailureCode, ModelAnswer, ModelProvider, ModelRequest, PromptId, PromptParameters, PromptRecord, PromptSource, TokenUsage } from './provider.js';

export const AI_STATUS_URL = '/v1/ai/status';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../migrations', import.meta.url));

export interface EnterpriseExtension extends ProfileExtension {
  readonly configuration: () => AskConfiguration | undefined;
}

export function createEnterpriseExtension(): EnterpriseExtension {
  let configuration: AskConfiguration | undefined;
  return {
    name: 'ask',
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    configuration: () => configuration,
    async configure(settings, env) {
      const configured = await configureAsk(settings, env);
      configuration = configured.configuration;
      return configured.outcome;
    },
    createAuditSink,
    routeGroups: [
      {
        routes: [
          {
            method: 'GET',
            url: AI_STATUS_URL,
            permission: 'principal',
            responseSchema: aiStatusResponseSchema,
            handler: async () => ({ preview: true }),
          },
        ],
      },
    ],
  };
}
