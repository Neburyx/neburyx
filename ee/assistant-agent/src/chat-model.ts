import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { readProviderKey, type ProviderConfiguration } from '@neburyx/ee-ai-runtime';
import { auditChatModel, type AuditedModelHook } from './audited-model.js';

/** The address of the service; a test points the model at a stub on the loopback address instead, and the environment's own base address is never used. */
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

export interface ChatModelOptions {
  readonly configuration: Pick<ProviderConfiguration, 'model' | 'key' | 'limits' | 'cache'>;
  /** Where a key given as an environment variable is read, at each call. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Only a test sets this, to a stub on the loopback address. */
  readonly baseUrl?: string;
  readonly hook: AuditedModelHook;
}

/**
 * The chat model of one turn, built from the provider configuration the operator already set: the same model, key, timeout, output-token limit and effort, and no retries. Every call it makes writes its audit event.
 * Undefined when the key cannot be read; the reason is never kept, since it could name a path.
 */
export async function createAnthropicChatModel(options: ChatModelOptions): Promise<BaseChatModel | undefined> {
  const { configuration } = options;
  const key = await readProviderKey(configuration, options.env);
  if (key === undefined) return undefined;
  const { timeoutMs, maxTokens, effort } = configuration.limits;
  const model = new ChatAnthropic({
    model: configuration.model,
    apiKey: key,
    maxTokens,
    maxRetries: 0,
    anthropicApiUrl: options.baseUrl ?? ANTHROPIC_BASE_URL,
    clientOptions: { timeout: timeoutMs },
    invocationKwargs: { output_config: { effort } },
  });
  return auditChatModel(model, { ...options.hook, ...(configuration.cache.enabled ? { cache: { ttl: configuration.cache.ttl } } : {}) });
}

export interface OpenAiCompatibleOptions {
  readonly model: string;
  /** The endpoint of an OpenAI-compatible server, without the `/v1` path. */
  readonly baseUrl: string;
  readonly limits: { readonly timeoutMs: number; readonly maxTokens: number };
  /** A key, only when the endpoint wants one. */
  readonly key?: string;
  readonly hook: AuditedModelHook;
}

const NO_KEY = 'a-local-server-needs-no-key';

/** The chat model for an OpenAI-compatible endpoint (a self-hosted server), with the same timeout and output-token limit as the Anthropic one and no retries. Every call it makes writes its audit event. */
export function createOpenAiCompatibleChatModel(options: OpenAiCompatibleOptions): BaseChatModel {
  const model = new ChatOpenAI({
    model: options.model,
    apiKey: options.key ?? NO_KEY,
    maxTokens: options.limits.maxTokens,
    timeout: options.limits.timeoutMs,
    maxRetries: 0,
    configuration: { baseURL: `${options.baseUrl.replace(/\/$/, '')}/v1` },
  });
  return auditChatModel(model, options.hook);
}
