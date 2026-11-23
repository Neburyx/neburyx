import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createCallRecorder, type AuditedCallContext } from '@neburyx/ee-ai-runtime';
import type { AuditEvent, AuditSink } from '@neburyx/contracts';
import { createAnthropicChatModel, createOpenAiCompatibleChatModel } from './chat-model.js';

interface Seen {
  readonly url: string | undefined;
  readonly headers: IncomingMessage['headers'];
  readonly body: Record<string, unknown>;
}

const seen: Seen[] = [];
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    seen.push({ url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
    response.setHeader('content-type', 'application/json');
    if (request.url?.includes('/messages') === true) response.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'model-a', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 30, output_tokens: 4, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } }));
    else response.end(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model: 'local-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } }));
  });
});
let baseUrl = '';
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const context: AuditedCallContext = { action: 'assistant.agent', actorId: 'p', actorRole: 'investigator', traceId: 't' };
const hookOf = (events: AuditEvent[]) => ({ recorder: createCallRecorder({ sink: { record: (event) => { events.push(event); return Promise.resolve(); } } as AuditSink }), context: () => context, promptId: 'assistant.agent', promptVersion: 1, modelRef: 'model-a' });
const configuration = (cache: boolean) => ({ model: 'model-a', key: { kind: 'env' as const, name: 'THE_KEY' }, cache: { enabled: cache, ttl: '1h' as const }, limits: { timeoutMs: 5000, maxRetries: 0, maxTokens: 321, effort: 'low' as const } });

describe('the chat models', () => {
  it('builds the Anthropic model from the provider settings: model, key, output limit, effort, no retries, and the cache breakpoints only when caching is on', async () => {
    const events: AuditEvent[] = [];
    seen.length = 0;
    const on = await createAnthropicChatModel({ configuration: configuration(true), env: { THE_KEY: 'k-1' }, baseUrl, hook: hookOf(events) });
    await on?.invoke([new SystemMessage('rules'), new HumanMessage('q')]);
    const off = await createAnthropicChatModel({ configuration: configuration(false), env: { THE_KEY: 'k-1' }, baseUrl, hook: hookOf(events) });
    await off?.invoke([new SystemMessage('rules'), new HumanMessage('q')]);
    expect(seen[0]?.body).toMatchObject({ model: 'model-a', max_tokens: 321 });
    expect(JSON.stringify(seen[0]?.body)).toContain('"ttl":"1h"');
    expect(JSON.stringify(seen[1]?.body)).not.toContain('cache_control');
    expect(JSON.stringify(seen[0]?.headers)).toContain('k-1');
    expect(events).toHaveLength(2);
    expect(events[0]?.detail).toMatchObject({ ai: { tokensIn: 30, tokensOut: 4, cacheReadTokens: 20, cacheWriteTokens: 5 } });
  });

  it('is unavailable when the key cannot be read, and never names the key', async () => {
    expect(await createAnthropicChatModel({ configuration: configuration(false), env: {}, baseUrl, hook: hookOf([]) })).toBeUndefined();
  });

  it('builds the OpenAI-compatible model for the endpoint, with the output limit and no key unless one is named', async () => {
    const events: AuditEvent[] = [];
    seen.length = 0;
    const model = createOpenAiCompatibleChatModel({ model: 'local-model', baseUrl, limits: { timeoutMs: 5000, maxTokens: 111 }, hook: hookOf(events) });
    await model.invoke([new SystemMessage('rules'), new HumanMessage('q')]);
    expect(seen[0]?.url).toContain('/v1/chat/completions');
    expect(seen[0]?.body).toMatchObject({ model: 'local-model' });
    expect(JSON.stringify(seen[0]?.body)).toContain('111');
    expect(JSON.stringify(seen[0]?.body)).not.toContain('cache_control');
    expect(events).toHaveLength(1);
  });
});
