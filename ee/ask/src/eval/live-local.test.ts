import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { configureProvider } from '@neburyx/ee-ai-runtime';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LiveProviderError, liveAssistantProvider, liveProvider, liveSummaryProvider, localRunOf } from './live.js';
import { readSummarySettings } from '../case-summary/settings.js';

const FOLDER = '/somewhere/absolute';
let server: Server;
let url: string;
let status = 200;
const bodies: Record<string, unknown>[] = [];
const headers: Record<string, string | string[] | undefined>[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      headers.push(request.headers);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(status === 200 ? { model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } : { error: { type: 'invalid_request_error' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  status = 200;
  bodies.length = 0;
  headers.length = 0;
});

const local = (grammar: 'on' | 'off', extra: Record<string, string> = {}): Record<string, string> => ({ NEBURYX_EVAL_LOCAL_URL: url, NEBURYX_EVAL_LOCAL_GRAMMAR: grammar, ...extra });
const REQUEST = { promptId: 'x', version: 1, values: 'v' } as const;

describe('a local run of the three live providers', () => {
  it('builds with no key at all, takes the limits of the same settings as an Anthropic run and sends no key', async () => {
    const asked = await liveProvider(local('off', { NEBURYX_ASK_MAX_TOKENS: '321', NEBURYX_ASK_CLASSIFICATION_MODEL: 'served-model' }), FOLDER);
    expect(asked).toMatchObject({ model: 'served-model', maxRetries: 0, label: { kind: 'local', grammar: false, grammarPrompts: [] } });
    await asked.provider.complete(REQUEST, new AbortController().signal);
    expect(bodies[0]).toMatchObject({ model: 'served-model', max_tokens: 321 });
    expect(bodies[0]?.['response_format']).toBeUndefined();
    expect(headers[0]?.['authorization']).toBeUndefined();

    const assistant = await liveAssistantProvider(local('off', { NEBURYX_ASSISTANT_MODEL: 'assistant-served', NEBURYX_ASSISTANT_MAX_OUTPUT_TOKENS: '1234' }), FOLDER);
    expect(assistant).toMatchObject({ model: 'assistant-served', outputLimit: 1234, label: { kind: 'local', grammar: false } });
    await assistant.provider.complete(REQUEST, new AbortController().signal);
    expect(bodies[1]).toMatchObject({ model: 'assistant-served', max_tokens: 1234 });

    const settings = readSummarySettings({ NEBURYX_SUMMARY_MODEL: 'summary-served' });
    if (!settings.ok) throw new Error('settings');
    const summary = await liveSummaryProvider(local('off'), FOLDER, settings.settings);
    expect(summary).toMatchObject({ model: 'summary-served', label: { kind: 'local' } });
  });

  it('with the grammar on makes one probe call for the one schema of the run, before the first call of the set, and says so', async () => {
    const asked = await liveProvider(local('on'), FOLDER, ['first-intent', 'second-intent']);
    expect(asked.label).toEqual({ kind: 'local', grammar: true, grammarPrompts: ['ask.classify'], probe: 'accepted' });
    expect(bodies).toHaveLength(1);
    const format = bodies[0]?.['response_format'] as { type: string; json_schema: { schema: { properties: { intent: { enum: unknown[] } } } } };
    expect(format.type).toBe('json_schema');
    expect(format.json_schema.schema.properties.intent.enum).toEqual(['first-intent', 'saved-pattern', 'second-intent', null]);

    bodies.length = 0;
    const assistant = await liveAssistantProvider(local('on'), FOLDER);
    expect(assistant.label).toEqual({ kind: 'local', grammar: true, grammarPrompts: ['assistant.route'], probe: 'accepted' });
    expect(bodies).toHaveLength(1);

    bodies.length = 0;
    const settings = readSummarySettings({});
    if (!settings.ok) throw new Error('settings');
    const summary = await liveSummaryProvider(local('on'), FOLDER, settings.settings);
    expect(summary.label).toEqual({ kind: 'local', grammar: true, grammarPrompts: ['case-summary'], probe: 'accepted' });
    expect(bodies).toHaveLength(1);
  });

  it('stops before the first call of the set when the probe of the schema does not succeed, naming the prompt and the failure code and nothing of the reply', async () => {
    status = 400;
    await expect(liveAssistantProvider(local('on'), FOLDER)).rejects.toThrow(/probe of the response schema of the prompt assistant\.route did not succeed \(provider-error\)/);
    await expect(liveProvider(local('on'), FOLDER)).rejects.toThrow(LiveProviderError);
    expect(bodies).toHaveLength(2);
  });

  it.each([
    ['an address that is not a loopback address', { NEBURYX_EVAL_LOCAL_URL: 'http://192.168.1.20:8089', NEBURYX_EVAL_LOCAL_GRAMMAR: 'off' }, /loopback/],
    ['the grammar without an address', { NEBURYX_EVAL_LOCAL_GRAMMAR: 'on' }, /without NEBURYX_EVAL_LOCAL_URL/],
    ['an address without the grammar named', { NEBURYX_EVAL_LOCAL_URL: 'http://127.0.0.1:8089' }, /must be on or off/],
    ['a grammar that is neither on nor off', { NEBURYX_EVAL_LOCAL_URL: 'http://127.0.0.1:8089', NEBURYX_EVAL_LOCAL_GRAMMAR: 'yes' }, /must be on or off/],
  ])('refuses %s before any call', async (_name, env, message) => {
    await expect(liveProvider(env, FOLDER)).rejects.toThrow(message);
    await expect(liveAssistantProvider(env, FOLDER)).rejects.toThrow(LiveProviderError);
    expect(bodies).toHaveLength(0);
  });

  it('asks the model not to think only when NEBURYX_EVAL_LOCAL_THINKING is off, labels the run so, and refuses another value or the setting without an address', async () => {
    const off = await liveProvider(local('off', { NEBURYX_EVAL_LOCAL_THINKING: 'off' }), FOLDER);
    expect(off.label).toMatchObject({ kind: 'local', thinking: 'off' });
    await off.provider.complete(REQUEST, new AbortController().signal);
    expect(bodies[0]).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    const on = await liveProvider(local('off', { NEBURYX_EVAL_LOCAL_THINKING: 'on' }), FOLDER);
    expect(on.label).not.toHaveProperty('thinking');
    await on.provider.complete(REQUEST, new AbortController().signal);
    expect(bodies[1]).not.toHaveProperty('chat_template_kwargs');
    await expect(liveProvider(local('off', { NEBURYX_EVAL_LOCAL_THINKING: 'maybe' }), FOLDER)).rejects.toThrow(/NEBURYX_EVAL_LOCAL_THINKING must be on or off/);
    await expect(liveProvider({ NEBURYX_EVAL_LOCAL_THINKING: 'off' }, FOLDER)).rejects.toThrow(/are set without NEBURYX_EVAL_LOCAL_URL/);
  });

  it('keeps the ordinary refusals: a key in the environment is still refused, and a run with no local setting needs its key file', async () => {
    await expect(liveProvider(local('off', { NEBURYX_ASK_API_KEY: 'x' }), FOLDER)).rejects.toThrow(/NEBURYX_ASK_API_KEY_FILE/);
    expect(localRunOf({})).toBeUndefined();
    await expect(liveProvider({}, FOLDER)).rejects.toThrow(LiveProviderError);
  });

  it('is no setting of the product: the provider setting of the application still refuses local', async () => {
    const outcome = await configureProvider({ NEBURYX_ASK_PROVIDER: 'local', NEBURYX_ASK_API_KEY: 'x' });
    expect(outcome.outcome.ok).toBe(false);
  });
});
