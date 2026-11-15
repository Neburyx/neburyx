import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnthropicProvider } from '../anthropic.js';
import { configureAsk } from '../configure.js';
import { summaryProviderConfiguration } from './provider-configuration.js';
import { readSummarySettings } from './settings.js';

const KEY = 'test-key-1234567890';
let server: Server;
let baseUrl: string;
const bodies: Record<string, unknown>[] = [];
let respondWith = 500;

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      response.writeHead(respondWith, { 'content-type': 'application/json' });
      response.end(
        respondWith === 200
          ? JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
          : '{"type":"error","error":{"type":"api_error","message":"down"}}',
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function configurations(askExtra: Record<string, string>, summaryExtra: Record<string, string> = {}) {
  const env = { NEBURYX_ASK_API_KEY: KEY, NEBURYX_ASK_MAPPING_FOLDER: '/etc/neburyx/mapping', ...askExtra };
  const { configuration } = await configureAsk(env);
  const read = readSummarySettings(summaryExtra);
  if (configuration === undefined || !read.ok) throw new Error('the test configuration is not valid');
  return { ask: configuration, own: summaryProviderConfiguration(configuration, read.settings), env };
}

describe("the summary's own provider configuration", () => {
  it("takes the summary's model, timeout, an output limit of 2,000 tokens and no retry, and leaves Ask's configuration alone", async () => {
    const { ask, own } = await configurations({ NEBURYX_ASK_MAX_RETRIES: '3', NEBURYX_ASK_MAX_TOKENS: '5000', NEBURYX_ASK_TIMEOUT_MS: '5000' }, { NEBURYX_SUMMARY_MODEL: 'summary-model', NEBURYX_SUMMARY_TIMEOUT_MS: '70000' });
    expect(own.model).toBe('summary-model');
    expect(own.limits).toMatchObject({ timeoutMs: 70_000, maxRetries: 0, maxTokens: 2000 });
    expect(ask.limits).toMatchObject({ timeoutMs: 5000, maxRetries: 3, maxTokens: 5000 });
    expect(ask.model).not.toBe('summary-model');
  });

  it('sends the summary model and an output limit of 2,000 tokens, and makes one request only on a server error even when Ask retries', async () => {
    const { own, env } = await configurations({ NEBURYX_ASK_MAX_RETRIES: '3' });
    bodies.length = 0;
    respondWith = 500;
    const answer = await createAnthropicProvider({ configuration: own, env, baseUrl }).complete({ promptId: 'case-summary', version: 1, instructions: 'i', values: 'v' }, new AbortController().signal);
    expect(answer.status).toBe('failed');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 2000 });
  });
});
