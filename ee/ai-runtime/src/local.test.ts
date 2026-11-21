import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalProviderSettingError, createLocalProvider, type LocalProviderOptions } from './local.js';
import type { ModelRequest } from './provider.js';
import { completion, json, startLocalStub, type LocalStub } from './testing/local-stub.js';

let stub: LocalStub;
beforeAll(async () => {
  stub = await startLocalStub();
});
afterAll(async () => {
  await stub.close();
});

const REQUEST: ModelRequest = { promptId: 'test.prompt', version: 2, instructions: 'FIXED-INSTRUCTIONS', values: 'THE-VALUES' };
const signal = (): AbortSignal => new AbortController().signal;
const options = (extra: Partial<LocalProviderOptions> = {}): LocalProviderOptions => ({ baseUrl: stub.baseUrl, model: 'local-model', limits: { timeoutMs: 1000, maxTokens: 777 }, ...extra });
const lastBody = (): Record<string, unknown> => JSON.parse(stub.bodies[stub.bodies.length - 1] ?? '{}') as Record<string, unknown>;

describe('what the provider sends', () => {
  it('sends the instructions as the one system message, the values as the one user message, the model, the token limit, no stream, no sampling field and no key', async () => {
    stub.reply = json(200, completion());
    await createLocalProvider(options()).complete(REQUEST, signal());
    expect(lastBody()).toEqual({ model: 'local-model', messages: [{ role: 'system', content: 'FIXED-INSTRUCTIONS' }, { role: 'user', content: 'THE-VALUES' }], max_tokens: 777, stream: false });
    const headers = stub.headers[stub.headers.length - 1] ?? {};
    expect(headers['authorization']).toBeUndefined();
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('asks the chat template not to think only when told to, and sends nothing of the kind by default', async () => {
    stub.reply = json(200, completion());
    await createLocalProvider(options({ thinking: 'off' })).complete(REQUEST, signal());
    expect(lastBody()['chat_template_kwargs']).toEqual({ enable_thinking: false });
    await createLocalProvider(options()).complete(REQUEST, signal());
    expect(lastBody()).not.toHaveProperty('chat_template_kwargs');
  });

  it('sends the values alone as the one user message when a request has no instructions', async () => {
    stub.reply = json(200, completion());
    await createLocalProvider(options()).complete({ promptId: 'p', version: 1, values: 'ONLY-VALUES' }, signal());
    expect(lastBody()['messages']).toEqual([{ role: 'user', content: 'ONLY-VALUES' }]);
  });

  it('asks for a json_schema response form only for a prompt that has a schema', async () => {
    const schema = { type: 'object', properties: { route: { type: 'string' } } };
    stub.reply = json(200, completion());
    const provider = createLocalProvider(options({ schemas: { 'test.prompt': schema } }));
    const constrained = await provider.complete(REQUEST, signal());
    expect(lastBody()['response_format']).toEqual({ type: 'json_schema', json_schema: { name: 'reply', strict: true, schema } });
    expect(constrained.status).toBe('ok');
    const free = await provider.complete({ ...REQUEST, promptId: 'other.prompt' }, signal());
    expect(lastBody()['response_format']).toBeUndefined();
    expect(free.status).toBe('ok');
  });
});

describe('what the provider reads', () => {
  it('returns the content only and never the reasoning the server returns apart from it', async () => {
    stub.reply = json(200, completion({}, { content: 'THE-ANSWER', reasoning_content: 'SECRET-REASONING' }));
    const answer = await createLocalProvider(options()).complete(REQUEST, signal());
    expect(answer).toMatchObject({ status: 'ok', text: 'THE-ANSWER', model: 'local-model' });
    expect(JSON.stringify(answer)).not.toContain('SECRET-REASONING');
  });

  it('maps a reply with empty content to a bad reply, and a reply cut at the token limit to truncated whatever it holds', async () => {
    const provider = createLocalProvider(options());
    stub.reply = json(200, completion({}, { content: '' }));
    expect(await provider.complete(REQUEST, signal())).toMatchObject({ status: 'failed', code: 'bad-reply' });
    stub.reply = json(200, { ...completion(), choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '', reasoning_content: 'still thinking' } }] });
    const cut = await provider.complete(REQUEST, signal());
    expect(cut).toMatchObject({ status: 'failed', code: 'truncated' });
    expect(JSON.stringify(cut)).not.toContain('still thinking');
  });

  it('maps a finish reason other than stop and length, a tool call and a refusal', async () => {
    const provider = createLocalProvider(options());
    stub.reply = json(200, { ...completion(), choices: [{ index: 0, finish_reason: 'content_filter', message: { role: 'assistant', content: 'x' } }] });
    expect(await provider.complete(REQUEST, signal())).toMatchObject({ status: 'failed', code: 'bad-reply' });
    stub.reply = json(200, completion({}, { tool_calls: [{ id: 't', type: 'function', function: { name: 'f', arguments: '{}' } }] }));
    expect(await provider.complete(REQUEST, signal())).toMatchObject({ status: 'failed', code: 'bad-reply' });
    stub.reply = json(200, completion({}, { refusal: 'no' }));
    expect(await provider.complete(REQUEST, signal())).toMatchObject({ status: 'refused' });
  });

  it.each([
    [401, 'rejected'],
    [403, 'rejected'],
    [429, 'rate-limited'],
    [400, 'provider-error'],
    [500, 'provider-error'],
    [503, 'provider-error'],
  ])('maps the status %i to %s and reports the status and a short error type only', async (status, code) => {
    stub.reply = json(status, { error: { type: 'some_error', message: 'PRIVATE-TEXT' } });
    const reported: unknown[] = [];
    const answer = await createLocalProvider(options({ onFailure: (failure) => reported.push(failure) })).complete(REQUEST, signal());
    expect(answer).toMatchObject({ status: 'failed', code });
    expect(reported).toEqual([{ code, status, errorType: 'some_error' }]);
    expect(JSON.stringify(reported)).not.toContain('PRIVATE-TEXT');
  });

  it('reports an error type that is not a short word as unrecognized', async () => {
    stub.reply = json(500, { error: { type: 'a very long and spaced type PRIVATE', message: 'x' } });
    const reported: unknown[] = [];
    await createLocalProvider(options({ onFailure: (failure) => reported.push(failure) })).complete(REQUEST, signal());
    expect(reported).toEqual([{ code: 'provider-error', status: 500, errorType: 'unrecognized' }]);
  });

  it('keeps usage unknown when a count is missing, never zero', async () => {
    stub.reply = json(200, completion({ usage: { prompt_tokens: 5 } }));
    expect(await createLocalProvider(options()).complete(REQUEST, signal())).toMatchObject({ status: 'ok', usage: { kind: 'unknown' } });
    stub.reply = json(200, completion());
    expect(await createLocalProvider(options()).complete(REQUEST, signal())).toMatchObject({ status: 'ok', usage: { kind: 'known', inputTokens: 12, outputTokens: 34 } });
  });

  it('does not follow a redirect', async () => {
    const target = createServer((_request, response) => response.end(JSON.stringify(completion())));
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const port = (target.address() as AddressInfo).port;
    stub.reply = (response) => {
      response.writeHead(307, { location: `http://127.0.0.1:${port}/v1/chat/completions` });
      response.end();
    };
    const answer = await createLocalProvider(options()).complete(REQUEST, signal());
    await new Promise<void>((resolve) => target.close(() => resolve()));
    expect(answer).toMatchObject({ status: 'failed', code: 'unreachable' });
  });

  it('ends a call as a timeout when the time limit passes while the body is being read, with the headers already received', async () => {
    stub.reply = (response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"choices":');
    };
    expect(await createLocalProvider(options({ limits: { timeoutMs: 150, maxTokens: 10 } })).complete(REQUEST, signal())).toMatchObject({ status: 'failed', code: 'timeout' });
    stub.reply = (response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.write('{"error":');
    };
    expect(await createLocalProvider(options({ limits: { timeoutMs: 150, maxTokens: 10 } })).complete(REQUEST, signal())).toMatchObject({ status: 'failed', code: 'timeout' });
  });

  it('ends a call whose caller aborts as a timeout', async () => {
    stub.reply = () => undefined;
    const controller = new AbortController();
    const pending = createLocalProvider(options({ limits: { timeoutMs: 30000, maxTokens: 10 } })).complete(REQUEST, controller.signal);
    setTimeout(() => controller.abort(), 50);
    expect(await pending).toMatchObject({ status: 'failed', code: 'timeout' });
  });

  it('writes no text of the request or the reply to a report', async () => {
    stub.reply = json(200, { unexpected: 'REPLY-TEXT' });
    const reported: unknown[] = [];
    await createLocalProvider(options({ onFailure: (failure) => reported.push(failure) })).complete(REQUEST, signal());
    expect(JSON.stringify(reported)).not.toMatch(/REPLY-TEXT|THE-VALUES|FIXED-INSTRUCTIONS/);
  });
});

describe('the address of the server', () => {
  it.each(['http://127.0.0.1:8089', 'http://localhost:8089', 'http://[::1]:8089'])('accepts %s', (baseUrl) => {
    expect(() => createLocalProvider(options({ baseUrl }))).not.toThrow();
  });

  it.each([
    ['https://127.0.0.1:8089', 'must use http'],
    ['http://0.0.0.0:8089', 'must be a loopback address'],
    ['http://192.168.1.20:8089', 'must be a loopback address'],
    ['http://example.test:8089', 'must be a loopback address'],
    ['http://user:secret@127.0.0.1:8089', 'user information'],
    ['::garbage::value', 'is not an address'],
  ])('refuses %s before any request, naming the setting and never the value', (baseUrl, reason) => {
    const before = stub.bodies.length;
    let failure: unknown;
    try {
      createLocalProvider(options({ baseUrl }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(LocalProviderSettingError);
    expect((failure as Error).message).toContain(reason);
    expect((failure as Error).message).not.toContain('secret');
    expect((failure as Error).message).not.toContain(baseUrl);
    expect(stub.bodies).toHaveLength(before);
  });
});
