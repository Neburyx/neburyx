import { createHash } from 'node:crypto';
import { BaseChatModel, type BaseChatModelCallOptions, type BindToolsInput } from '@langchain/core/language_models/chat_models';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { AIMessageChunk, BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import { AuditUnavailableError, type AuditedCallContext, type CallRecorder, type FailureCode, type PromptRecord, type TokenUsage } from '@neburyx/ee-ai-runtime';

/** What a caller keeps of one call besides its audit event: the record of the turn's calls, with the fixed instructions, the messages sent and what came back. */
export interface CallTrace {
  received(answer: { readonly text: string; readonly usage: TokenUsage; readonly model: string; readonly prompt: PromptRecord }): void;
  end(outcome: { readonly error?: unknown; readonly aborted: boolean; readonly failure?: { readonly code: string; readonly errorClass: string; readonly errorCode?: string } }): void;
}

export interface AuditedModelHook {
  readonly recorder: CallRecorder;
  /** Who asked and where the call belongs; read at each call, so one model can serve one turn. */
  readonly context: () => AuditedCallContext;
  readonly promptId: string;
  readonly promptVersion: number;
  /** The configured model, the reference a failed or cancelled call is recorded under. */
  readonly modelRef: string;
  /** Starts the record of one call, with the system text, the SHA-256 of it and the rest of the messages as text. */
  readonly trace?: (call: { readonly instructions: string; readonly instructionsSha256: string; readonly values: string }) => CallTrace;
  /** Anthropic prompt caching: the system text and the last message of each call carry a cache breakpoint with this time to live. Absent, no marker is sent. */
  readonly cache?: { readonly ttl: '5m' | '1h' };
}

const UNKNOWN_USAGE: TokenUsage = { kind: 'unknown' };
/** What the audit event accepts as a prompt id: no call goes out with an id the event cannot hold. */
const AUDIT_LABEL = /^[A-Za-z0-9._:/-]{1,200}$/;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_RATE_LIMITED = 429;
const HTTP_SERVER_ERROR = 500;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** The text of the system messages of a call: the fixed part of the prompt, which the audit event records by hash. */
export function systemTextOf(messages: readonly BaseMessage[]): string {
  return messages
    .filter((message) => message.type === 'system')
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
    .join('\n');
}

/** LangChain counts the cached tokens inside `input_tokens`; the event holds what the provider counts after the last cache breakpoint. */
export function usageOf(metadata: unknown): TokenUsage {
  if (!isRecord(metadata)) return UNKNOWN_USAGE;
  const { input_tokens: input, output_tokens: output, input_token_details: details } = metadata;
  if (!isCount(input) || !isCount(output)) return UNKNOWN_USAGE;
  const read = isRecord(details) && isCount(details['cache_read']) ? details['cache_read'] : undefined;
  const written = isRecord(details) && isCount(details['cache_creation']) ? details['cache_creation'] : undefined;
  return { kind: 'known', inputTokens: Math.max(0, input - (read ?? 0) - (written ?? 0)), outputTokens: output, ...(read === undefined ? {} : { cacheReadTokens: read }), ...(written === undefined ? {} : { cacheWriteTokens: written }) };
}

/** The failure code of a call that threw: by the status of the reply when the provider sent one, otherwise by what the error says. */
export function failureCodeOf(error: unknown, aborted: boolean): FailureCode {
  const status = isRecord(error) && typeof error['status'] === 'number' ? error['status'] : undefined;
  if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) return 'rejected';
  if (status === HTTP_RATE_LIMITED) return 'rate-limited';
  if (status !== undefined && status >= HTTP_SERVER_ERROR) return 'provider-error';
  const text = error instanceof Error ? `${error.name} ${error.message}`.toLowerCase() : '';
  if (aborted || text.includes('timeout') || text.includes('abort')) return 'timeout';
  if (text.includes('econnrefused') || text.includes('enotfound') || text.includes('fetch failed') || text.includes('connection')) return 'unreachable';
  return 'provider-error';
}

const SHORT_CODE = /^[A-Za-z0-9._:/-]{1,80}$/;
const shortCodeOf = (value: unknown): string | undefined => (typeof value === 'string' || typeof value === 'number') && SHORT_CODE.test(String(value)) ? String(value) : undefined;

/** The class of an error the provider's client threw and its HTTP status or code (its own, or its cause's, such as a reset connection), as short codes; never the message, which can hold a value. */
export function failureDetailOf(error: unknown): { readonly errorClass: string; readonly errorCode?: string } {
  const held = isRecord(error) ? error : {};
  const cause = isRecord(held['cause']) ? held['cause'] : {};
  const errorClass = shortCodeOf(error instanceof Error ? error.constructor.name : undefined) ?? shortCodeOf(held['name']) ?? 'Error';
  const errorCode = shortCodeOf(held['status']) ?? shortCodeOf(held['code']) ?? shortCodeOf(cause['code']);
  return { errorClass, ...(errorCode === undefined ? {} : { errorCode }) };
}

export class AuditedModelFailure extends Error {
  constructor(
    readonly code: FailureCode,
    options: { readonly cause: unknown },
  ) {
    super(`the model call failed: ${code}`, options);
  }
}

const textOf = (content: BaseMessage['content']): string => (typeof content === 'string' ? content : JSON.stringify(content));

/** The messages after the system text, one line each, with the tool calls a reply made and the results the tools returned. */
function valuesOf(messages: readonly BaseMessage[]): string {
  return messages
    .filter((message) => message.type !== 'system')
    .map((message) => {
      const calls = 'tool_calls' in message && Array.isArray(message.tool_calls) && message.tool_calls.length > 0 ? ` ${JSON.stringify(message.tool_calls.map((call: { name: string; args: unknown }) => ({ name: call.name, args: call.args })))}` : '';
      return `${message.type}: ${textOf(message.content)}${calls}`;
    })
    .join('\n');
}

const promptOf = (hook: AuditedModelHook, messages: readonly BaseMessage[]): PromptRecord => ({ id: hook.promptId, version: hook.promptVersion, sha256: createHash('sha256').update(systemTextOf(messages), 'utf8').digest('hex') });

const blockOf = (content: BaseMessage['content'], breakpoint: Record<string, unknown>): BaseMessage['content'] =>
  typeof content === 'string' ? [{ type: 'text', text: content, cache_control: breakpoint }] : content.map((block, index) => (index === content.length - 1 ? { ...block, cache_control: breakpoint } : block));

/** The messages of a call with the cache breakpoints of Anthropic's prompt caching: one at the end of the system text and one at the last message, which is how a growing history is read from the cache. */
export function withCacheMarkers(messages: readonly BaseMessage[], ttl: '5m' | '1h'): BaseMessage[] {
  const breakpoint = ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  const lastSystem = messages.map((message) => message.type).lastIndexOf('system');
  return messages.map((message, index) => (index === lastSystem || index === messages.length - 1 ? withContent(message, blockOf(message.content, breakpoint)) : message));
}

function withContent(message: BaseMessage, content: BaseMessage['content']): BaseMessage {
  // a copy of the message of the same class, with its content replaced; the original is never changed
  const copy = Object.create(Object.getPrototypeOf(message)) as BaseMessage;
  return Object.assign(copy, message, { content });
}

type Inner = Runnable<BaseLanguageModelInput, AIMessageChunk>;

/** A chat model that makes every call through the inner one and writes the call's audit event. A copy that deepagents makes by binding tools is another audited model, never the bare inner one. */
class AuditedChatModel extends BaseChatModel {
  constructor(
    private readonly inner: Inner,
    private readonly hook: AuditedModelHook,
  ) {
    super({});
  }

  _llmType(): string {
    return 'audited';
  }

  override bindTools(tools: BindToolsInput[], kwargs?: Partial<BaseChatModelCallOptions>): Runnable<BaseLanguageModelInput, AIMessageChunk, BaseChatModelCallOptions> {
    // a chat model may or may not bind tools; the type of the inner runnable does not say
    const bindable = this.inner as { bindTools?: (tools: BindToolsInput[], kwargs?: Partial<BaseChatModelCallOptions>) => Inner };
    if (bindable.bindTools === undefined) throw new Error('the model cannot call tools');
    // the bound copy is an audited model too; the base class types the return as a runnable of the call options
    return new AuditedChatModel(bindable.bindTools(tools, kwargs), this.hook) as unknown as Runnable<BaseLanguageModelInput, AIMessageChunk, BaseChatModelCallOptions>;
  }

  async _generate(messages: BaseMessage[], options: this['ParsedCallOptions']): Promise<ChatResult> {
    const { hook } = this;
    if (!AUDIT_LABEL.test(hook.promptId) || !Number.isInteger(hook.promptVersion) || hook.promptVersion < 0) throw new AuditUnavailableError();
    const prompt = promptOf(hook, messages);
    const trace = hook.trace?.({ instructions: systemTextOf(messages), instructionsSha256: prompt.sha256, values: valuesOf(messages) });
    let message: AIMessageChunk;
    try {
      message = await this.inner.invoke(hook.cache === undefined ? messages : withCacheMarkers(messages, hook.cache.ttl), options.signal === undefined ? {} : { signal: options.signal });
    } catch (error) {
      const code = failureCodeOf(error, options.signal?.aborted === true);
      const failure = failureDetailOf(error);
      trace?.end({ error, aborted: options.signal?.aborted === true, failure: { code, ...failure } });
      await hook.recorder.record(hook.context(), prompt, { result: 'failed', modelRef: hook.modelRef, usage: UNKNOWN_USAGE, failure });
      throw new AuditedModelFailure(code, { cause: error });
    }
    const usage = usageOf(message.usage_metadata);
    trace?.received({ text: `${textOf(message.content)}${message.tool_calls === undefined || message.tool_calls.length === 0 ? '' : ` ${JSON.stringify(message.tool_calls.map((call) => ({ name: call.name, args: call.args })))}`}`, usage, model: hook.modelRef, prompt });
    trace?.end({ aborted: false });
    await hook.recorder.record(hook.context(), prompt, { result: 'success', modelRef: hook.modelRef, usage });
    return { generations: [{ text: typeof message.content === 'string' ? message.content : '', message }] };
  }
}

/**
 * Puts the audit event under every call the chat model makes: one event for each call, when it ends, with the token counts the provider stated. A call that throws (including one the turn's signal cancelled) is
 * recorded as failed and rethrown as a failure with a product code; an event that cannot be built rejects with the audit's own error and the answer is never returned.
 */
export function auditChatModel(model: BaseChatModel, hook: AuditedModelHook): BaseChatModel {
  return new AuditedChatModel(model, hook);
}
