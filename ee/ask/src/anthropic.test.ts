import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INVALID_SPAN_CONTEXT, trace } from '@opentelemetry/api';
import { AI_DEFAULTS } from '@neburyx/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAnthropicProvider, type ProviderFailure } from './anthropic.js';
import { configureAsk, type AskConfiguration } from './configure.js';
import type { ModelAnswer, ModelRequest } from './provider.js';

const KEY = 'test-key-1234567890';
const REQUEST: ModelRequest = { promptId: 'summary.view', parameters: { view: 'a synthetic view of two people' } };
const SIGNAL = new AbortController().signal;

interface Captured {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

type Handler = (captured: Captured, response: ServerResponse) => void;

let server: Server;
let baseUrl: string;
let handler: Handler;
let seen: Captured[] = [];
const sockets = new Set<import('node:net').Socket>();
const folder = mkdtempSync(join(tmpdir(), 'ee-ask-anthropic-'));

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const captured = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(captured);
      handler(captured, response);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(folder, { recursive: true, force: true });
});

afterEach(() => {
  seen = [];
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Handler {
  return (_captured, response) => {
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
}

const message = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  content: [{ type: 'text', text: 'A synthetic answer.' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 5 },
  ...extra,
});

async function configurationWith(limits: Partial<{ timeout_ms: number; max_retries: number; max_tokens: number; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; cache: { enabled?: boolean; ttl?: '5m' | '1h' } }> = {}, key: { env: string } | { file: string } = { env: 'STUB_KEY' }, model = 'claude-sonnet-5-5'): Promise<AskConfiguration> {
  const { configuration } = await configureAsk({ preview: true, provider: 'anthropic', model, key, ...limits }, { STUB_KEY: KEY });
  if (configuration === undefined) throw new Error('the configuration of the test is not valid');
  return configuration;
}

async function complete(configuration: AskConfiguration, env: Record<string, string | undefined> = { STUB_KEY: KEY }, signal: AbortSignal = SIGNAL): Promise<ModelAnswer> {
  return createAnthropicProvider({ configuration, env, baseUrl }).complete(REQUEST, signal);
}

async function answerTo(handlerOfTest: Handler, limits: Parameters<typeof configurationWith>[0] = { max_retries: 0 }): Promise<ModelAnswer> {
  handler = handlerOfTest;
  return complete(await configurationWith(limits));
}

describe('the request', () => {
  it('is one message to the Messages API, with the model, the limit, the effort and the filled prompt, and the key as the only credential', async () => {
    handler = reply(200, message());
    const configuration = await configurationWith({ effort: 'high', max_tokens: 321, cache: { enabled: false } });
    // The client library reads these from the process environment, so that is where the test sets them.
    vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-key');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'ambient-token');
    vi.stubEnv('ANTHROPIC_PROFILE', 'ambient-profile');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:1');
    const answer = await complete(configuration);
    expect(answer.status).toBe('ok');
    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/v1/messages');
    const body = JSON.parse(request?.body ?? '') as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'output_config']);
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 321, output_config: { effort: 'high' } });
    const resolved = configuration.registry.resolve('summary.view', REQUEST.parameters);
    expect(body.messages).toEqual([{ role: 'user', content: resolved.text }]);
    const headers = JSON.stringify(request?.headers);
    expect(request?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request?.headers['x-api-key']).toBeUndefined();
    expect(headers).not.toMatch(/ambient/);
  });

  it('names the default effort when the configuration does not choose one', async () => {
    handler = reply(200, message());
    await complete(await configurationWith());
    expect((JSON.parse(seen[0]?.body ?? '') as { output_config: { effort: string } }).output_config.effort).toBe(AI_DEFAULTS.effort);
  });

  it('never sends sampling parameters, tools, a system prompt (with caching off), thinking or an assistant turn', async () => {
    handler = reply(200, message());
    await complete(await configurationWith({ cache: { enabled: false } }));
    const text = seen[0]?.body ?? '';
    for (const name of ['temperature', 'top_p', 'top_k', 'tools', 'tool_choice', 'system', 'thinking', 'stop_sequences']) expect(text).not.toContain(`"${name}"`);
    expect((JSON.parse(text) as { messages: { role: string }[] }).messages.map((m) => m.role)).toEqual(['user']);
  });

  it('reads the key from its variable at each call, and from an owner-only file', async () => {
    handler = reply(200, message());
    const configuration = await configurationWith();
    await complete(configuration, { STUB_KEY: 'first-key' });
    await complete(configuration, { STUB_KEY: 'second-key' });
    expect(seen.map((s) => s.headers.authorization)).toEqual(['Bearer first-key', 'Bearer second-key']);
    const path = join(folder, 'key-file');
    writeFileSync(path, 'file-key\n');
    chmodSync(path, 0o600);
    seen = [];
    await complete(await configurationWith({}, { file: path }));
    expect(seen[0]?.headers.authorization).toBe('Bearer file-key');
  });

  it.each([
    ['a NAME=value line', 'ANTHROPIC_API_KEY=file-key\n'],
    ['an export line with quotes', 'export ANTHROPIC_API_KEY="file-key"\n'],
  ])('reads the same key from a file with %s', async (_name, text) => {
    handler = reply(200, message());
    const path = join(folder, 'assignment-key');
    writeFileSync(path, text);
    chmodSync(path, 0o600);
    await complete(await configurationWith({}, { file: path }));
    expect(seen[0]?.headers.authorization).toBe('Bearer file-key');
  });

  it('answers rejected with no request for a file that came to hold two assignments, with no text in the answer', async () => {
    const path = join(folder, 'two-key');
    writeFileSync(path, 'file-key');
    chmodSync(path, 0o600);
    const configuration = await configurationWith({}, { file: path });
    writeFileSync(path, 'A_KEY=sentinel-one\nB_KEY=sentinel-two\n');
    seen = [];
    const answer = await complete(configuration);
    expect(answer).toMatchObject({ status: 'failed', code: 'rejected' });
    expect(JSON.stringify(answer)).not.toMatch(/sentinel|two-key/);
    expect(seen).toEqual([]);
  });

  it('writes nothing to the process output or error output, and produces no trace span', async () => {
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');
    const log = vi.spyOn(console, 'log');
    const debug = vi.spyOn(console, 'debug');
    const previous = process.env.ANTHROPIC_LOG;
    process.env.ANTHROPIC_LOG = 'debug';
    vi.stubEnv('ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE', 'content');
    let spans = 0;
    const span = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
    const tracer = {
      startSpan: () => (spans++, span),
      startActiveSpan: (...args: unknown[]) => {
        spans++;
        return (args[args.length - 1] as (given: typeof span) => unknown)(span);
      },
    };
    trace.setGlobalTracerProvider({ getTracer: () => tracer as never });
    try {
      handler = reply(200, message());
      await complete(await configurationWith());
      handler = reply(500, { type: 'error', error: { type: 'api_error', message: 'prompt text and key must not leak' } });
      await complete(await configurationWith());
    } finally {
      trace.disable();
      if (previous === undefined) delete process.env.ANTHROPIC_LOG;
      else process.env.ANTHROPIC_LOG = previous;
    }
    for (const spy of [out, err, log, debug]) {
      const written = spy.mock.calls.map((call) => String(call[0])).join('');
      expect(written).not.toContain(KEY);
      expect(written).not.toContain('a synthetic view');
    }
    expect(debug).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(spans).toBe(0);
  });
});

describe('a key that cannot be read when the call is made', () => {
  it.each([
    ['a variable that is unset', { env: 'STUB_KEY' }, {}],
    ['a variable that is empty', { env: 'STUB_KEY' }, { STUB_KEY: '' }],
  ])('makes no request for %s and answers rejected', async (_name, key, env) => {
    handler = reply(200, message());
    const answer = await complete(await configurationWith({}, key), env);
    expect(answer).toMatchObject({ status: 'failed', code: 'rejected' });
    expect(seen).toHaveLength(0);
  });

  it('makes no request for a file that is removed, emptied or readable by others, and holds no path or text in the answer', async () => {
    const path = join(folder, 'changing-key');
    writeFileSync(path, 'file-key-text');
    chmodSync(path, 0o600);
    const configuration = await configurationWith({}, { file: path });
    handler = reply(200, message());
    expect((await complete(configuration)).status).toBe('ok');
    seen = [];
    chmodSync(path, 0o644);
    const loose = await complete(configuration);
    writeFileSync(path, '');
    chmodSync(path, 0o600);
    const empty = await complete(configuration);
    rmSync(path);
    const removed = await complete(configuration);
    for (const answer of [loose, empty, removed]) {
      expect(answer).toMatchObject({ status: 'failed', code: 'rejected' });
      expect(JSON.stringify(answer)).not.toMatch(/changing-key|file-key-text/);
    }
    expect(seen).toHaveLength(0);
  });
});

describe('the answers', () => {
  it('is ok with the text, the usage, the model the reply names and the prompt record', async () => {
    const answer = await answerTo(reply(200, message({ model: 'claude-haiku-5-5' })));
    expect(answer).toMatchObject({ status: 'ok', text: 'A synthetic answer.', usage: { kind: 'known', inputTokens: 12, outputTokens: 5 }, model: 'claude-haiku-5-5', prompt: { id: 'summary.view', source: 'builtin' } });
  });

  it('joins the text blocks in order and holds no thinking text', async () => {
    const answer = await answerTo(reply(200, message({ content: [{ type: 'thinking', thinking: 'secret reasoning', signature: 's' }, { type: 'text', text: 'One. ' }, { type: 'text', text: 'Two.' }] })));
    expect(answer).toMatchObject({ status: 'ok', text: 'One. Two.' });
    expect(JSON.stringify(answer)).not.toContain('secret reasoning');
  });

  it('accepts stop_sequence as an end', async () => {
    expect((await answerTo(reply(200, message({ stop_reason: 'stop_sequence' })))).status).toBe('ok');
  });

  it('is refused whatever the content holds, even when it is missing', async () => {
    expect(await answerTo(reply(200, message({ stop_reason: 'refusal', content: undefined })))).toMatchObject({ status: 'refused' });
  });

  it('is refused, with usage and no text, when the model refuses', async () => {
    const answer = await answerTo(reply(200, message({ stop_reason: 'refusal', content: [{ type: 'text', text: 'I cannot help' }] })));
    expect(answer).toMatchObject({ status: 'refused', usage: { kind: 'known', inputTokens: 12, outputTokens: 5 } });
    expect(JSON.stringify(answer)).not.toContain('I cannot help');
  });

  it.each(['max_tokens', 'model_context_window_exceeded'])('is truncated at %s and carries no text', async (stop) => {
    const answer = await answerTo(reply(200, message({ stop_reason: stop })));
    expect(answer).toMatchObject({ status: 'failed', code: 'truncated' });
    expect(JSON.stringify(answer)).not.toContain('A synthetic answer');
  });

  it.each([
    ['tool_use as the stop reason', message({ stop_reason: 'tool_use' })],
    ['pause_turn', message({ stop_reason: 'pause_turn' })],
    ['a tool-use block with end_turn and text beside it', message({ content: [{ type: 'text', text: 'x' }, { type: 'tool_use', id: 't', name: 'n', input: {} }] })],
    ['no text block', message({ content: [{ type: 'thinking', thinking: 't', signature: 's' }] })],
    ['an empty content', message({ content: [] })],
    ['a missing content', message({ content: undefined })],
    ['text blocks that are empty', message({ content: [{ type: 'text', text: '' }] })],
    ['a missing stop reason', message({ stop_reason: null })],
    ['an unknown stop reason', message({ stop_reason: 'something_new' })],
    ['a body that is a list', []],
    ['a body that is not JSON', 'plain text'],
    ['a body without content', { type: 'message' }],
  ])('is a bad reply for %s, with no text', async (_name, body) => {
    const answer = await answerTo(reply(200, body));
    expect(answer).toMatchObject({ status: 'failed', code: 'bad-reply' });
    expect(answer).not.toHaveProperty('text');
  });

  it.each([
    ['usage absent', { usage: undefined }],
    ['a decimal count', { usage: { input_tokens: 1.5, output_tokens: 2 } }],
    ['a negative count', { usage: { input_tokens: -1, output_tokens: 2 } }],
    ['one count', { usage: { input_tokens: 3 } }],
    ['a count given as text', { usage: { input_tokens: '3', output_tokens: 2 } }],
  ])('has unknown usage for %s', async (_name, extra) => {
    const answer = await answerTo(reply(200, message(extra)));
    expect(answer).toMatchObject({ status: 'ok', usage: { kind: 'unknown' } });
  });
});

describe('failures', () => {
  it.each([
    [401, 'rejected'],
    [403, 'rejected'],
    [429, 'rate-limited'],
    [500, 'provider-error'],
    [529, 'provider-error'],
    [400, 'provider-error'],
    [404, 'provider-error'],
    [422, 'provider-error'],
  ])('maps status %i to %s after one request with no retries', async (status, code) => {
    const answer = await answerTo(reply(status, { type: 'error', error: { type: 'x', message: 'the prompt and the key must not appear' } }));
    expect(answer).toMatchObject({ status: 'failed', code, usage: { kind: 'unknown' } });
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(answer)).not.toMatch(/must not appear|a synthetic view/);
    expect(JSON.stringify(answer)).not.toContain(KEY);
  });

  it('tries again as often as the configuration says, and answers when a later try succeeds', async () => {
    let count = 0;
    const answer = await answerTo((captured, response) => {
      count += 1;
      if (count <= 2) reply(500, { type: 'error', error: { type: 'api_error', message: 'x' } }, { 'retry-after-ms': '1' })(captured, response);
      else reply(200, message())(captured, response);
    }, { max_retries: 2 });
    expect(answer.status).toBe('ok');
    expect(seen).toHaveLength(3);
  });

  it('gives rate-limited after the last try when every try is limited', async () => {
    const answer = await answerTo(reply(429, { type: 'error', error: { type: 'rate_limit_error', message: 'x' } }, { 'retry-after-ms': '1' }), { max_retries: 2 });
    expect(answer).toMatchObject({ code: 'rate-limited' });
    expect(seen).toHaveLength(3);
  });

  it('tells the stub the configured timeout, and never retries by the library default', async () => {
    await answerTo(reply(500, { type: 'error', error: { type: 'api_error', message: 'x' } }), { timeout_ms: 7_000, max_retries: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers['x-stainless-timeout']).toBe('7');
  });

  it('answers unreachable when the connection is refused or destroyed', async () => {
    const configuration = await configurationWith({ max_retries: 0 });
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const refused = await createAnthropicProvider({ configuration, env: { STUB_KEY: KEY }, baseUrl: `http://127.0.0.1:${port}` }).complete(REQUEST, SIGNAL);
    expect(refused).toMatchObject({ status: 'failed', code: 'unreachable' });
    handler = (captured, response) => {
      void captured;
      response.destroy();
    };
    expect(await complete(configuration)).toMatchObject({ status: 'failed', code: 'unreachable' });
  });

  it('answers timeout within the configured timeout when the stub never replies', async () => {
    handler = () => undefined;
    const configuration = await configurationWith({ timeout_ms: 1_000, max_retries: 0 });
    const started = Date.now();
    const answer = await complete(configuration);
    expect(answer).toMatchObject({ status: 'failed', code: 'timeout' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('answers timeout when the headers arrive and the body never finishes', async () => {
    handler = (_captured, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"id":');
    };
    const started = Date.now();
    const answer = await complete(await configurationWith({ timeout_ms: 1_000, max_retries: 0 }));
    expect(answer).toMatchObject({ status: 'failed', code: 'timeout', usage: { kind: 'unknown' } });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('holds one deadline over the retries: a stub that never replies is one request and one timeout, not three', async () => {
    handler = () => undefined;
    const started = Date.now();
    const answer = await complete(await configurationWith({ timeout_ms: 1_000, max_retries: 2 }));
    expect(answer).toMatchObject({ status: 'failed', code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(seen).toHaveLength(1);
  });

  it('answers timeout and stops waiting when the caller aborts', async () => {
    handler = () => undefined;
    const controller = new AbortController();
    const pending = complete(await configurationWith({ timeout_ms: 60_000, max_retries: 0 }), { STUB_KEY: KEY }, controller.signal);
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    expect(await pending).toMatchObject({ status: 'failed', code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('answers timeout at once for a signal that is already aborted, without a request', async () => {
    handler = reply(200, message());
    const controller = new AbortController();
    controller.abort();
    expect(await complete(await configurationWith(), { STUB_KEY: KEY }, controller.signal)).toMatchObject({ status: 'failed', code: 'timeout' });
    expect(seen).toHaveLength(0);
  });
});

describe('a model name the client library has retired', () => {
  it('can make the library write one warning with the model name only, never the key or the prompt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    handler = reply(200, message());
    await complete(await configurationWith({}, { env: 'STUB_KEY' }, 'claude-sonnet-4-5'));
    const written = warn.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain("'claude-sonnet-4-5'");
    expect(written).not.toContain(KEY);
    expect(written).not.toContain('a synthetic view');
  });
});

describe('the failure record', () => {
  async function failureOf(handlerOfTest: Handler, limits: Parameters<typeof configurationWith>[0] = { max_retries: 0 }, env: Record<string, string | undefined> = { STUB_KEY: KEY }): Promise<{ answer: ModelAnswer; records: ProviderFailure[] }> {
    handler = handlerOfTest;
    const records: ProviderFailure[] = [];
    const answer = await createAnthropicProvider({ configuration: await configurationWith(limits), env, baseUrl, onFailure: (record) => void records.push(record) }).complete(REQUEST, SIGNAL);
    return { answer, records };
  }
  const apiError = (type: unknown): unknown => ({ type: 'error', error: { type, message: 'SENTINEL-BODY' } });

  it.each([
    [401, 'authentication_error', 'rejected'],
    [429, 'rate_limit_error', 'rate-limited'],
    [500, 'api_error', 'provider-error'],
  ])('holds the code, the status %i and the error type once, after the last retry', async (status, type, code) => {
    const { records } = await failureOf(reply(status, apiError(type)), { max_retries: 1 });
    expect(records).toEqual([{ code, status, errorType: type }]);
  });

  it.each([
    ['a body that is not JSON', 'SENTINEL-BODY not json'],
    ['a body with no error type', { type: 'error', error: { message: 'SENTINEL-BODY' } }],
    ['a type that is not text', apiError(7)],
    ['a type with a space', apiError('bad type')],
    ['a type with a digit', apiError('error1')],
    ['a type longer than 64 characters', apiError('a'.repeat(65))],
  ])('holds status 400 and the type unrecognized for %s', async (_name, body) => {
    const { records } = await failureOf(reply(400, body));
    expect(records).toEqual([{ code: 'provider-error', status: 400, errorType: 'unrecognized' }]);
  });

  it('accepts a type of 64 letters and underscores', async () => {
    const type = 'a_'.repeat(32);
    expect((await failureOf(reply(400, apiError(type)))).records).toEqual([{ code: 'provider-error', status: 400, errorType: type }]);
  });

  it('holds the code only when no reply arrived or its body was not parsed', async () => {
    const unparsed = await failureOf(reply(200, 'not json at all'));
    expect(unparsed.records).toEqual([{ code: 'bad-reply' }]);
    expect(unparsed.answer).toMatchObject({ status: 'failed', code: 'bad-reply' });
    expect((await failureOf(reply(200, message()), { max_retries: 0 }, {})).records).toEqual([{ code: 'rejected' }]);
    const timed = await failureOf(() => undefined, { timeout_ms: 100, max_retries: 0 });
    expect(timed.records).toEqual([{ code: 'timeout' }]);
  });

  it('holds status 200 and no type for a reply the provider cannot use or one cut off at the token limit', async () => {
    expect((await failureOf(reply(200, message({ content: 'x' })))).records).toEqual([{ code: 'bad-reply', status: 200 }]);
    expect((await failureOf(reply(200, message({ stop_reason: 'max_tokens' })))).records).toEqual([{ code: 'truncated', status: 200 }]);
  });

  it('is not called for an ok or a refused reply, and a throwing report leaves the answer as it was', async () => {
    expect((await failureOf(reply(200, message()))).records).toEqual([]);
    expect((await failureOf(reply(200, message({ stop_reason: 'refusal' })))).records).toEqual([]);
    handler = reply(500, apiError('api_error'));
    const throwing = createAnthropicProvider({ configuration: await configurationWith({ max_retries: 0 }), env: { STUB_KEY: KEY }, baseUrl, onFailure: () => { throw new Error('SENTINEL-THROW'); } });
    expect(await throwing.complete(REQUEST, SIGNAL)).toMatchObject({ status: 'failed', code: 'provider-error' });
  });

  it('holds only the fields code, status and errorType, and no sentinel', async () => {
    const { records } = await failureOf(reply(500, apiError('api_error')));
    expect(Object.keys(records[0] ?? {}).sort()).toEqual(['code', 'errorType', 'status']);
    expect(JSON.stringify(records)).not.toMatch(/SENTINEL|a synthetic view/);
    expect(JSON.stringify(records)).not.toContain(KEY);
  });
});

describe('the usage of a failed answer', () => {
  const KNOWN = { kind: 'known', inputTokens: 12, outputTokens: 256 };

  it.each(['max_tokens', 'model_context_window_exceeded'])('is the figures of the reply for a %s stop, with code truncated and no text', async (stop) => {
    const answer = await answerTo(reply(200, message({ stop_reason: stop, usage: { input_tokens: 12, output_tokens: 256 } })));
    expect(answer).toMatchObject({ status: 'failed', code: 'truncated', usage: KNOWN });
    expect(answer).not.toHaveProperty('text');
  });

  it.each([
    ['an unknown content block', { content: [{ type: 'tool_use', id: 't', name: 'n', input: {} }] }],
    ['no text', { content: [] }],
    ['an unexpected stop reason', { stop_reason: 'pause_turn' }],
    ['content that is not a list', { content: 'x' }],
  ])('is the figures of the reply for a body with %s that cannot be used', async (_name, extra) => {
    const answer = await answerTo(reply(200, message({ usage: { input_tokens: 12, output_tokens: 256 }, ...extra })));
    expect(answer).toMatchObject({ status: 'failed', code: 'bad-reply', usage: KNOWN });
  });

  it.each([
    ['usage absent', { usage: undefined }],
    ['a decimal count', { usage: { input_tokens: 1.5, output_tokens: 2 } }],
    ['a negative count', { usage: { input_tokens: -1, output_tokens: 2 } }],
    ['one count', { usage: { input_tokens: 3 } }],
    ['a count given as text', { usage: { input_tokens: '3', output_tokens: 2 } }],
  ])('is unknown for a truncated reply with %s', async (_name, extra) => {
    expect(await answerTo(reply(200, message({ stop_reason: 'max_tokens', ...extra })))).toMatchObject({ status: 'failed', code: 'truncated', usage: { kind: 'unknown' } });
  });

  it.each([['a list', '[1,2]'], ['null', 'null'], ['text', '"text"']])('is unknown for a 200 body that is %s', async (_name, body) => {
    expect(await answerTo(reply(200, body))).toMatchObject({ status: 'failed', code: 'bad-reply', usage: { kind: 'unknown' } });
  });

  it('is unknown for a body that is not JSON, for a failure with an error body that states usage, for an unreadable key, for a timeout and for a destroyed connection', async () => {
    expect(await answerTo(reply(200, 'not json at all'))).toMatchObject({ status: 'failed', usage: { kind: 'unknown' } });
    expect(await answerTo(reply(500, { type: 'error', error: { type: 'api_error', message: 'm' }, usage: { input_tokens: 9, output_tokens: 9 } }))).toMatchObject({ status: 'failed', code: 'provider-error', usage: { kind: 'unknown' } });
    handler = reply(200, message());
    expect(await complete(await configurationWith({ max_retries: 0 }), {})).toMatchObject({ status: 'failed', code: 'rejected', usage: { kind: 'unknown' } });
    handler = () => undefined;
    expect(await complete(await configurationWith({ timeout_ms: 100, max_retries: 0 }))).toMatchObject({ status: 'failed', code: 'timeout', usage: { kind: 'unknown' } });
    handler = (_captured, response) => {
      response.destroy();
    };
    expect(await complete(await configurationWith({ max_retries: 0 }))).toMatchObject({ status: 'failed', code: 'unreachable', usage: { kind: 'unknown' } });
  });

  it('keeps a refusal and an ok reply as they were', async () => {
    expect(await answerTo(reply(200, message({ stop_reason: 'refusal' })))).toMatchObject({ status: 'refused', usage: { kind: 'known', inputTokens: 12, outputTokens: 5 } });
    expect(await answerTo(reply(200, message()))).toMatchObject({ status: 'ok', usage: { kind: 'known', inputTokens: 12, outputTokens: 5 } });
  });
});

describe('prompt caching', () => {
  type Sent = { model: string; max_tokens: number; output_config: { effort: string }; system?: unknown; messages: { role: string; content: string }[] };
  const sentBody = (): Sent => JSON.parse(seen[0]?.body ?? '') as Sent;
  const VALUE_REQUEST: ModelRequest = { promptId: 'ask.plan', parameters: { catalog: 'SENTINEL-CATALOG', question: 'SENTINEL-QUESTION [[values]]' } };

  async function callWith(settings: Parameters<typeof configurationWith>[0], request: ModelRequest = VALUE_REQUEST, prompts?: Record<string, string>): Promise<AskConfiguration> {
    handler = reply(200, message());
    const { configuration } = await configureAsk({ preview: true, provider: 'anthropic', model: 'claude-sonnet-5-5', key: { env: 'STUB_KEY' }, ...(prompts === undefined ? {} : { prompts }), ...settings }, { STUB_KEY: KEY });
    if (configuration === undefined) throw new Error('the configuration of the test is not valid');
    await createAnthropicProvider({ configuration, env: { STUB_KEY: KEY }, baseUrl }).complete(request, SIGNAL);
    return configuration;
  }

  it('sends the instructions as the one system block with the breakpoint, and the values as the user message, by default', async () => {
    const configuration = await callWith({});
    const resolved = configuration.registry.resolve('ask.plan', VALUE_REQUEST.parameters);
    const body = sentBody();
    expect(body.system).toEqual([{ type: 'text', text: resolved.instructions, cache_control: { type: 'ephemeral' } }]);
    expect(body.messages).toEqual([{ role: 'user', content: resolved.values }]);
    expect(JSON.stringify(body.system)).not.toContain('ttl');
  });

  it('names the one hour lifetime when it is chosen', async () => {
    await callWith({ cache: { ttl: '1h' } });
    expect((sentBody().system as { cache_control: unknown }[])[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it.each([['5m'], ['1h']] as const)('never has a value of the request inside the system block, with the lifetime %s', async (ttl) => {
    await callWith({ cache: { ttl } });
    const body = sentBody();
    expect(JSON.stringify(body.system)).not.toMatch(/SENTINEL|\[\[values\]\]/);
    expect(body.messages[0]?.content).toContain('SENTINEL-CATALOG');
    expect(body.messages[0]?.content).toContain('SENTINEL-QUESTION [[values]]');
  });

  it.each([['summary.view', { view: 'v' }], ['assistant.route', { message: 'm', view: 'v' }]] as const)('puts the instructions of %s in the system block too', async (promptId, parameters) => {
    await callWith({}, { promptId, parameters });
    expect((sentBody().system as unknown[]).length).toBe(1);
  });

  it('sends no system field and no cache_control anywhere with caching off, and the whole prompt as the user message', async () => {
    const configuration = await callWith({ cache: { enabled: false, ttl: '1h' } });
    const body = seen[0]?.body ?? '';
    expect(body).not.toContain('cache_control');
    expect(body).not.toContain('"system"');
    expect(sentBody().messages).toEqual([{ role: 'user', content: configuration.registry.resolve('ask.plan', VALUE_REQUEST.parameters).text }]);
  });

  it('sends no system field for a replacement prompt that declares no values line, even with caching on', async () => {
    const path = join(folder, 'no-boundary.txt');
    writeFileSync(path, 'Plan {{question}} {{catalog}}');
    const configuration = await callWith({}, VALUE_REQUEST, { 'ask.plan': path });
    const body = seen[0]?.body ?? '';
    expect(body).not.toContain('cache_control');
    expect(body).not.toContain('"system"');
    expect(sentBody().messages[0]?.content).toBe(configuration.registry.resolve('ask.plan', VALUE_REQUEST.parameters).text);
  });

  it('caches the instructions of a replacement prompt with a values line, and sends the marker nowhere', async () => {
    const path = join(folder, 'boundary.txt');
    writeFileSync(path, 'Plan the question.\n[[values]]\nQ: {{question}} {{catalog}}');
    await callWith({}, VALUE_REQUEST, { 'ask.plan': path });
    const body = sentBody();
    expect(body.system).toEqual([{ type: 'text', text: 'Plan the question.', cache_control: { type: 'ephemeral' } }]);
    expect(body.messages[0]?.content).toBe('Q: SENTINEL-QUESTION [[values]] SENTINEL-CATALOG');
  });

  it('changes nothing else in the request: the model, the limit, the effort, no tools and no sampling parameters', async () => {
    await callWith({ effort: 'high', max_tokens: 321 });
    const body = sentBody();
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'output_config', 'system']);
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 321, output_config: { effort: 'high' } });
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });
});

describe('the cache counts of the usage', () => {
  it('are the counts of the reply, next to the input and output counts', async () => {
    const answer = await answerTo(reply(200, message({ usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 } })));
    expect(answer).toMatchObject({ status: 'ok', usage: { kind: 'known', inputTokens: 12, outputTokens: 5, cacheReadTokens: 300, cacheWriteTokens: 40 } });
  });

  it.each([
    ['null', { cache_read_input_tokens: null, cache_creation_input_tokens: null }],
    ['absent', {}],
    ['decimals', { cache_read_input_tokens: 1.5, cache_creation_input_tokens: 2.5 }],
    ['negative', { cache_read_input_tokens: -1, cache_creation_input_tokens: -2 }],
    ['text', { cache_read_input_tokens: '3', cache_creation_input_tokens: '4' }],
  ])('are left out, never zero, when they are %s, and the other counts stay', async (_name, cache) => {
    const answer = await answerTo(reply(200, message({ usage: { input_tokens: 12, output_tokens: 5, ...cache } })));
    expect(answer).toMatchObject({ status: 'ok', usage: { kind: 'known', inputTokens: 12, outputTokens: 5 } });
    expect(answer).not.toHaveProperty('usage.cacheReadTokens');
    expect(answer).not.toHaveProperty('usage.cacheWriteTokens');
  });

  it('keep a stated zero as zero, and keep the one that is valid when the other is not', async () => {
    expect(await answerTo(reply(200, message({ usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })))).toMatchObject({ usage: { cacheReadTokens: 0, cacheWriteTokens: 0 } });
    const one = await answerTo(reply(200, message({ usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 7, cache_creation_input_tokens: null } })));
    expect(one).toMatchObject({ usage: { cacheReadTokens: 7 } });
    expect(one).not.toHaveProperty('usage.cacheWriteTokens');
  });

  it('are carried by a refusal and by a reply cut off at the token limit', async () => {
    const usage = { input_tokens: 12, output_tokens: 256, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 };
    expect(await answerTo(reply(200, message({ stop_reason: 'refusal', usage })))).toMatchObject({ status: 'refused', usage: { cacheReadTokens: 300, cacheWriteTokens: 40 } });
    expect(await answerTo(reply(200, message({ stop_reason: 'max_tokens', usage })))).toMatchObject({ status: 'failed', code: 'truncated', usage: { cacheReadTokens: 300, cacheWriteTokens: 40 } });
  });
});
