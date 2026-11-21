import { promptRecordOf, type FailureCode, type ModelAnswer, type ModelProvider, type ModelRequest, type PromptRecord, type TokenUsage } from './provider.js';
import type { ProviderFailure } from './anthropic.js';

export class LocalProviderSettingError extends Error {
  override readonly name = 'LocalProviderSettingError';
}

export interface LocalProviderOptions {
  /** The address of the local server: `http`, a loopback host, no user information. */
  readonly baseUrl: string;
  readonly model: string;
  readonly limits: { readonly timeoutMs: number; readonly maxTokens: number };
  /** `off` asks the server's chat template not to think (`chat_template_kwargs` with `enable_thinking` false); absent, the model's own default is in effect. */
  readonly thinking?: 'off';
  /** A JSON schema by prompt id; a call for a prompt that has one asks the server to constrain its reply to it. */
  readonly schemas?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Called once for each failed call. Whatever it does or throws, the answer is unchanged. */
  readonly onFailure?: (failure: ProviderFailure) => void;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const COMPLETIONS_PATH = '/v1/chat/completions';
const ERROR_TYPE = /^[A-Za-z_]{1,64}$/;
const UNRECOGNIZED = 'unrecognized';
const UNKNOWN_USAGE: TokenUsage = { kind: 'unknown' };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** The address the calls go to, or a setting error that names the setting and never the value. */
function completionsUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new LocalProviderSettingError('the local server address is not an address');
  }
  if (parsed.protocol !== 'http:') throw new LocalProviderSettingError('the local server address must use http');
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) throw new LocalProviderSettingError('the local server address must be a loopback address (127.0.0.1, ::1 or localhost)');
  if (parsed.username !== '' || parsed.password !== '') throw new LocalProviderSettingError('the local server address must not hold user information');
  return `${parsed.origin}${COMPLETIONS_PATH}`;
}

function usageOf(value: unknown): TokenUsage {
  if (!isRecord(value)) return UNKNOWN_USAGE;
  const { prompt_tokens: input, completion_tokens: output } = value;
  return isCount(input) && isCount(output) ? { kind: 'known', inputTokens: input, outputTokens: output } : UNKNOWN_USAGE;
}

function answerOf(body: unknown, prompt: PromptRecord, model: string): ModelAnswer {
  if (!isRecord(body)) return { status: 'failed', code: 'bad-reply', usage: UNKNOWN_USAGE, prompt };
  const usage = usageOf(body.usage);
  const choice = Array.isArray(body.choices) ? (body.choices as readonly unknown[])[0] : undefined;
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
  if (!isRecord(choice) || message === undefined) return { status: 'failed', code: 'bad-reply', usage, prompt };
  const content = typeof message.content === 'string' ? message.content : '';
  const received = content === '' ? {} : { received: content };
  const refusal = message.refusal;
  if (typeof refusal === 'string' && refusal !== '') return { status: 'refused', usage, prompt, ...received };
  const finish = choice.finish_reason;
  if (finish === 'length') return { status: 'failed', code: 'truncated', usage, prompt, ...received };
  const bad: ModelAnswer = { status: 'failed', code: 'bad-reply', usage, prompt, ...received };
  if (finish !== 'stop') return bad;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return bad;
  if (content === '') return bad;
  return { status: 'ok', text: content, usage, model: typeof body.model === 'string' && body.model !== '' ? body.model : model, prompt };
}

function codeOfStatus(status: number): FailureCode {
  if (status === 401 || status === 403) return 'rejected';
  if (status === 429) return 'rate-limited';
  return 'provider-error';
}

function errorTypeOf(body: unknown): string {
  const type = isRecord(body) && isRecord(body.error) ? body.error.type : undefined;
  return typeof type === 'string' && ERROR_TYPE.test(type) ? type : UNRECOGNIZED;
}

async function jsonOf(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The provider for a local server that speaks the OpenAI chat completions form: one system message with the fixed instructions when there are any, one user message with the values, no sampling field, no tools, no stream.
 * It sends no key and builds only for a loopback address; the reasoning a model returns apart from its answer is never read. A failed call is reported to `onFailure` and nothing else is logged.
 */
export function createLocalProvider(options: LocalProviderOptions): ModelProvider {
  const url = completionsUrl(options.baseUrl);
  const { timeoutMs, maxTokens } = options.limits;
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
    const record = promptRecordOf(request);
    const failed = (code: FailureCode): ModelAnswer => ({ status: 'failed', code, usage: UNKNOWN_USAGE, prompt: record });
    const schema = options.schemas?.[request.promptId];
    const grammar = schema !== undefined;
    const messages = [...(request.instructions === undefined ? [] : [{ role: 'system', content: request.instructions }]), { role: 'user', content: request.values }];
    const body = JSON.stringify({
      model: options.model,
      messages,
      max_tokens: maxTokens,
      stream: false,
      ...(options.thinking === 'off' ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      ...(grammar ? { response_format: { type: 'json_schema', json_schema: { name: 'reply', strict: true, schema } } } : {}),
    });

    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const stop = (): void => deadline.abort();
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error', signal: deadline.signal });
      if (!response.ok) {
        const code = codeOfStatus(response.status);
        const error = await jsonOf(response);
        if (deadline.signal.aborted) return failed('timeout');
        note({ code, status: response.status, errorType: errorTypeOf(error) });
        return failed(code);
      }
      const parsed = await jsonOf(response);
      if (deadline.signal.aborted) return failed('timeout');
      const answer = answerOf(parsed, record, options.model);
      if (answer.status === 'failed') note({ code: answer.code, status: response.status });
      return answer;
    } catch {
      if (deadline.signal.aborted) return failed('timeout');
      note({ code: 'unreachable' });
      return failed('unreachable');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    }
  }
}
