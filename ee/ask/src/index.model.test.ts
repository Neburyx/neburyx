import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuditEvent, AuditSink } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const events: AuditEvent[] = [];
const sink: AuditSink = { record: (event) => (events.push(event), Promise.resolve()) };

vi.mock('@neburyx/ee-audit', () => ({ createAuditSink: () => ({ sink, close: async () => undefined }) }));

const { createEnterpriseExtension } = await import('./index.js');

const SINK_CONTEXT = { databaseUrl: 'postgres://app@db.example.test:5432/neburyx', poolSize: 1, connectionTimeoutMs: 100, statementTimeoutMs: 100, queryTimeoutMs: 100, newId: () => 'id', onConnectionError: () => undefined };
const SETTINGS = { preview: true, provider: 'anthropic' as const, model: 'claude-sonnet-5-5', key: { env: 'ONLY_IN_THE_START_ENV' }, timeout_ms: 5_000 };

let server: Server;
let status = 200;
let failureBody: unknown;
let baseUrl: string;
const authorizations: (string | undefined)[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    request.resume();
    request.on('end', () => {
      if (status !== 200 || failureBody !== undefined) {
        response.writeHead(status, { 'content-type': 'application/json', 'x-sentinel': 'SENTINEL-HEADER' });
        response.end(typeof failureBody === 'string' ? failureBody : JSON.stringify(failureBody));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'A synthetic answer.' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the model of the extension', () => {
  it('is the audited provider: one call reaches the stub with the key from the environment given at start-up, and one event is recorded', async () => {
    const extension = createEnterpriseExtension({ modelBaseUrl: baseUrl });
    expect((await extension.configure?.(SETTINGS, { ONLY_IN_THE_START_ENV: 'key-from-the-start-environment' }))?.ok).toBe(true);
    extension.createAuditSink?.(SINK_CONTEXT);
    const model = extension.model();
    expect(model).toBeDefined();
    const answer = await model?.call({ promptId: 'summary.view', parameters: { view: 'a synthetic view' } }, { actorId: '01939999-0000-7000-8000-0000000000aa', actorRole: 'investigator', traceId: 'tr-1' }, new AbortController().signal);
    expect(answer).toMatchObject({ status: 'ok', text: 'A synthetic answer.' });
    expect(authorizations).toEqual(['Bearer key-from-the-start-environment']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'ai.summary', result: 'success', detail: { ai: { modelRef: 'claude-sonnet-5-5', promptId: 'summary.view' } } });
  });
});

describe('the failure line of the extension', () => {
  const context = { actorId: '01939999-0000-7000-8000-0000000000aa', actorRole: 'investigator' as const, traceId: 'tr-1' };

  async function callWith(httpStatus: number, body?: unknown): Promise<{ lines: string[]; answer: unknown }> {
    status = httpStatus;
    failureBody = body;
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => (lines.push(String(chunk)), true)) as typeof process.stdout.write);
    try {
      const extension = createEnterpriseExtension({ modelBaseUrl: baseUrl });
      await extension.configure?.({ ...SETTINGS, max_retries: 0 }, { ONLY_IN_THE_START_ENV: 'SENTINEL-KEY' });
      extension.createAuditSink?.(SINK_CONTEXT);
      const answer = await extension.model()?.call({ promptId: 'summary.view', parameters: { view: 'SENTINEL-PROMPT' } }, context, new AbortController().signal);
      return { lines, answer };
    } finally {
      vi.restoreAllMocks();
      status = 200;
      failureBody = undefined;
    }
  }

  it.each([
    [401, 'authentication_error', 'rejected'],
    [429, 'rate_limit_error', 'rate-limited'],
    [500, 'api_error', 'provider-error'],
    [400, 'unrecognized', 'provider-error'],
  ])('writes one line in the API log shape for status %i, with no sentinel in it', async (httpStatus, type, code) => {
    const { lines } = await callWith(httpStatus, httpStatus === 400 ? 'SENTINEL-BODY not json' : { type: 'error', error: { type, message: 'SENTINEL-BODY' } });
    const failures = lines.filter((line) => line.includes('ai.provider_failure'));
    expect(failures).toHaveLength(1);
    const parsed = JSON.parse(failures[0] ?? '{}') as Record<string, unknown>;
    expect(parsed).toMatchObject({ level: 40, event: 'ai.provider_failure', code, status: httpStatus, errorType: type, msg: expect.any(String) });
    expect(typeof parsed.time).toBe('number');
    expect(lines.join('')).not.toMatch(/SENTINEL/);
  });

  it('writes the line with status 200 and no error type for a reply cut off at the token limit', async () => {
    const { lines } = await callWith(200, { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'SENTINEL-TEXT' }], stop_reason: 'max_tokens', usage: { input_tokens: 3, output_tokens: 4 } });
    const parsed = JSON.parse(lines.find((line) => line.includes('ai.provider_failure')) ?? '{}') as Record<string, unknown>;
    expect(parsed).toMatchObject({ code: 'truncated', status: 200 });
    expect(parsed).not.toHaveProperty('errorType');
    expect(lines.join('')).not.toMatch(/SENTINEL/);
  });

  it('writes nothing for a call that succeeds', async () => {
    const { lines, answer } = await callWith(200);
    expect(answer).toMatchObject({ status: 'ok' });
    expect(lines).toEqual([]);
  });

  it('leaves the answer as it was when the output cannot be written', async () => {
    status = 500;
    vi.spyOn(process.stdout, 'write').mockImplementation((() => { throw new Error('SENTINEL-WRITE'); }) as typeof process.stdout.write);
    try {
      const extension = createEnterpriseExtension({ modelBaseUrl: baseUrl });
      await extension.configure?.({ ...SETTINGS, max_retries: 0 }, { ONLY_IN_THE_START_ENV: 'SENTINEL-KEY' });
      extension.createAuditSink?.(SINK_CONTEXT);
      const answer = await extension.model()?.call({ promptId: 'summary.view', parameters: { view: 'x' } }, context, new AbortController().signal);
      expect(answer).toMatchObject({ status: 'failed', code: 'provider-error' });
    } finally {
      vi.restoreAllMocks();
      status = 200;
    }
  });
});
