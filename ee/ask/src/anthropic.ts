import { readFile, stat } from 'node:fs/promises';
import Anthropic, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import type { AskConfiguration } from './configure.js';
import { parseKeyText } from './key-file.js';
import type { FailureCode, ModelAnswer, ModelProvider, ModelRequest, PromptRecord, TokenUsage } from './provider.js';

/** The address of the service. A test points the provider at a stub instead; the environment's own base address is never used. */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

const GROUP_AND_OTHER_BITS = 0o077;

export interface AnthropicProviderOptions {
  readonly configuration: Pick<AskConfiguration, 'model' | 'key' | 'limits' | 'registry'>;
  /** Where a key given as an environment variable is read, at each call. The default is the process environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Only a test sets this, to a stub on the loopback address. */
  readonly baseUrl?: string;
  /** Called once for each failed call, after the last retry. Whatever it does or throws, the answer is unchanged. */
  readonly onFailure?: (failure: ProviderFailure) => void;
}

/** What a failed call reports: the failure code, the status of the reply when one arrived, and, for a non-2xx status, the API's error type or `unrecognized`. Nothing else. */
export interface ProviderFailure {
  readonly code: FailureCode;
  readonly status?: number;
  readonly errorType?: string;
}

const ERROR_TYPE = /^[A-Za-z_]{1,64}$/;
const UNRECOGNIZED = 'unrecognized';

const noop = (): void => undefined;
const SILENT_LOGGER = { error: noop, warn: noop, info: noop, debug: noop };

/** The key, read from its reference now, or undefined when it cannot be read; the reason is never kept, since it could name a path. */
async function readKey(configuration: AnthropicProviderOptions['configuration'], env: Readonly<Record<string, string | undefined>>): Promise<string | undefined> {
  const reference = configuration.key;
  let text: string | undefined;
  if (reference.kind === 'env') {
    text = env[reference.name];
  } else {
    try {
      const found = await stat(reference.path);
      if (!found.isFile() || found.size === 0 || (found.mode & GROUP_AND_OTHER_BITS) !== 0) return undefined;
      const parsed = parseKeyText(await readFile(reference.path, 'utf8'));
      return parsed.ok ? parsed.key : undefined;
    } catch {
      return undefined;
    }
  }
  const key = text?.trim();
  return key === undefined || key === '' ? undefined : key;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const UNKNOWN_USAGE: TokenUsage = { kind: 'unknown' };

function usageOf(value: unknown): TokenUsage {
  if (!isRecord(value)) return UNKNOWN_USAGE;
  const { input_tokens: input, output_tokens: output } = value;
  if (typeof input === 'number' && typeof output === 'number' && Number.isInteger(input) && Number.isInteger(output) && input >= 0 && output >= 0) {
    return { kind: 'known', inputTokens: input, outputTokens: output };
  }
  return UNKNOWN_USAGE;
}

/** Maps the body of a reply to an answer; whatever it does not recognize is a bad reply, never text. */
function answerOf(body: unknown, prompt: PromptRecord, model: string): ModelAnswer {
  if (!isRecord(body)) return { status: 'failed', code: 'bad-reply', usage: UNKNOWN_USAGE, prompt };
  const usage = usageOf(body.usage);
  const bad: ModelAnswer = { status: 'failed', code: 'bad-reply', usage, prompt };
  const stop = body.stop_reason;
  // A refusal is a refusal whatever the content holds, and it never carries text.
  if (stop === 'refusal') return { status: 'refused', usage, prompt };
  if (!Array.isArray(body.content)) return bad;
  if (stop === 'max_tokens' || stop === 'model_context_window_exceeded') return { status: 'failed', code: 'truncated', usage, prompt };
  if (stop !== 'end_turn' && stop !== 'stop_sequence') return bad;
  const texts: string[] = [];
  for (const block of body.content as readonly unknown[]) {
    if (!isRecord(block) || typeof block.type !== 'string') return bad;
    if (block.type === 'text') {
      if (typeof block.text !== 'string') return bad;
      texts.push(block.text);
    } else if (block.type !== 'thinking' && block.type !== 'redacted_thinking') {
      return bad;
    }
  }
  const text = texts.join('');
  if (texts.length === 0 || text === '') return bad;
  return { status: 'ok', text, usage, model: typeof body.model === 'string' && body.model !== '' ? body.model : model, prompt };
}

function codeOf(error: unknown): FailureCode {
  // A reply the client library could not read as JSON.
  if (error instanceof SyntaxError) return 'bad-reply';
  if (error instanceof APIConnectionTimeoutError || error instanceof APIUserAbortError) return 'timeout';
  if (error instanceof APIConnectionError) return 'unreachable';
  if (error instanceof APIError) {
    if (error.status !== undefined && error.status >= 200 && error.status < 300) return 'bad-reply';
    if (error.status === 401 || error.status === 403) return 'rejected';
    if (error.status === 429) return 'rate-limited';
  }
  return 'provider-error';
}

function failureOf(error: unknown, code: FailureCode): ProviderFailure {
  if (!(error instanceof APIError) || error.status === undefined) return { code };
  if (error.status >= 200 && error.status < 300) return { code, status: error.status };
  const body: unknown = error.error;
  const type = isRecord(body) && isRecord(body.error) ? body.error.type : undefined;
  return { code, status: error.status, errorType: typeof type === 'string' && ERROR_TYPE.test(type) ? type : UNRECOGNIZED };
}

/**
 * The provider for the Messages API: one user message, no tools, no sampling parameters, no prefill, no thinking, the effort always named.
 * The key is read from its reference at each call and handed to a client built for that call; a failed call is reported to `onFailure` and nothing else is logged.
 */
export function createAnthropicProvider(options: AnthropicProviderOptions): ModelProvider {
  const { configuration } = options;
  const { timeoutMs, maxRetries, maxTokens, effort } = configuration.limits;
  return {
    async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelAnswer> {
      const noted: { failure?: ProviderFailure } = {};
      const answer = await attempt(request, signal, (given) => {
        noted.failure = given;
      });
      if (answer.status === 'failed') {
        try {
          options.onFailure?.(noted.failure ?? { code: answer.code });
        } catch {
          // The report never changes the answer.
        }
      }
      return answer;
    },
  };

  async function attempt(request: ModelRequest, signal: AbortSignal, note: (failure: ProviderFailure) => void): Promise<ModelAnswer> {
    const resolved = configuration.registry.resolve(request.promptId, request.parameters);
    const failed = (code: FailureCode): ModelAnswer => ({ status: 'failed', code, usage: UNKNOWN_USAGE, prompt: resolved.record });
    const key = await readKey(configuration, options.env ?? process.env);
    if (key === undefined) return failed('rejected');

    // One deadline over the whole call: the client's own timeout is per attempt and ends when the headers arrive.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const stop = (): void => deadline.abort();
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
    const expired = new Promise<'timeout'>((resolve) => {
      deadline.signal.addEventListener('abort', () => resolve('timeout'), { once: true });
    });
    try {
      const client = new Anthropic({
        apiKey: key,
        authToken: null,
        webhookKey: null,
        baseURL: options.baseUrl ?? ANTHROPIC_BASE_URL,
        logLevel: 'off',
        logger: SILENT_LOGGER,
        openTelemetry: false,
        timeout: timeoutMs,
        maxRetries,
      });
      const sent = client.messages
        .create(
          { model: configuration.model, max_tokens: maxTokens, output_config: { effort }, messages: [{ role: 'user', content: resolved.text }] },
          { signal: deadline.signal },
        )
        .then((body): ModelAnswer => answerOf(body, resolved.record, configuration.model));
      // The race keeps a late rejection from the abandoned call from surfacing.
      sent.catch(noop);
      const first = await Promise.race([sent, expired]);
      if (first !== 'timeout' && first.status === 'failed') note({ code: first.code, status: 200 });
      return first === 'timeout' ? failed('timeout') : first;
    } catch (error) {
      if (deadline.signal.aborted) return failed('timeout');
      const code = codeOf(error);
      note(failureOf(error, code));
      return failed(code);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    }
  }
}
