import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuditEvent, AuditSink, ExtensionLogger } from '@neburyx/contracts';
import type { ModelRequest } from './provider.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const events: AuditEvent[] = [];
const sink: AuditSink = { record: (event) => (events.push(event), Promise.resolve()) };

vi.mock('@neburyx/ee-audit', () => ({ createAuditSink: () => ({ sink, close: async () => undefined }) }));

const { createEnterpriseExtension } = await import('./index.js');
const { createFailureReporter } = await import('./failure-line.js');

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

  interface Logged {
    readonly fields: Readonly<Record<string, unknown>>;
    readonly message: string;
  }

  async function callWith(httpStatus: number, body?: unknown, logger: ExtensionLogger | undefined = undefined, request: ModelRequest = { promptId: 'summary.view', parameters: { view: 'SENTINEL-PROMPT' } }): Promise<{ logged: Logged[]; written: string[]; answer: unknown }> {
    status = httpStatus;
    failureBody = body;
    const logged: Logged[] = [];
    const written: string[] = [];
    const capture = (chunk: string | Uint8Array): boolean => (written.push(String(chunk)), true);
    vi.spyOn(process.stdout, 'write').mockImplementation(capture as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture as typeof process.stderr.write);
    try {
      const extension = createEnterpriseExtension({ modelBaseUrl: baseUrl });
      extension.attachLogger?.(logger ?? { warn: (fields, message) => void logged.push({ fields, message }) });
      await extension.configure?.({ ...SETTINGS, max_retries: 0 }, { ONLY_IN_THE_START_ENV: 'SENTINEL-KEY' });
      extension.createAuditSink?.(SINK_CONTEXT);
      const answer = await extension.model()?.call(request, context, new AbortController().signal);
      return { logged, written, answer };
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
  ])('hands the logger one warning for status %i, with no sentinel in it and nothing on the process output', async (httpStatus, type, code) => {
    const { logged, written } = await callWith(httpStatus, httpStatus === 400 ? 'SENTINEL-BODY not json' : { type: 'error', error: { type, message: 'SENTINEL-BODY' } });
    expect(logged).toEqual([{ fields: { event: 'ai.provider_failure', code, status: httpStatus, errorType: type }, message: 'a model call failed' }]);
    expect(JSON.stringify(logged)).not.toMatch(/SENTINEL/);
    expect(written).toEqual([]);
  });

  it('keeps the question and the key out of the warning for a failing plan call', async () => {
    const { logged, written } = await callWith(500, { type: 'error', error: { type: 'api_error', message: 'SENTINEL-BODY' } }, undefined, { promptId: 'ask.plan', parameters: { catalog: 'a catalog', vocabulary: 'V1', question: 'SENTINEL-QUESTION' } });
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged)).not.toMatch(/SENTINEL/);
    expect(written).toEqual([]);
  });

  it('hands the logger status 200 and no error type for a reply cut off at the token limit', async () => {
    const { logged } = await callWith(200, { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'SENTINEL-TEXT' }], stop_reason: 'max_tokens', usage: { input_tokens: 3, output_tokens: 4 } });
    expect(logged).toEqual([{ fields: { event: 'ai.provider_failure', code: 'truncated', status: 200 }, message: 'a model call failed' }]);
    expect(JSON.stringify(logged)).not.toMatch(/SENTINEL/);
  });

  it('records one failed audit event with the tokens of a reply cut off at the token limit', async () => {
    events.length = 0;
    status = 200;
    failureBody = { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'cut' }], stop_reason: 'max_tokens', usage: { input_tokens: 12, output_tokens: 256 } };
    try {
      const extension = createEnterpriseExtension({ modelBaseUrl: baseUrl });
      await extension.configure?.({ ...SETTINGS, max_retries: 0 }, { ONLY_IN_THE_START_ENV: 'SENTINEL-KEY' });
      extension.createAuditSink?.(SINK_CONTEXT);
      const answer = await extension.model()?.call({ promptId: 'summary.view', parameters: { view: 'a view' } }, context, new AbortController().signal);
      expect(answer).toMatchObject({ status: 'failed', code: 'truncated', usage: { kind: 'known', inputTokens: 12, outputTokens: 256 } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ result: 'failed', detail: { ai: { tokensIn: 12, tokensOut: 256 } } });
    } finally {
      failureBody = undefined;
    }
  });

  it('records one event with the cache counts the stub states, next to the input and output counts', async () => {
    events.length = 0;
    status = 200;
    failureBody = { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'A synthetic answer.' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 } };
    try {
      const extension = createEnterpriseExtension({ modelBaseUrl: baseUrl });
      await extension.configure?.(SETTINGS, { ONLY_IN_THE_START_ENV: 'SENTINEL-KEY' });
      extension.createAuditSink?.(SINK_CONTEXT);
      await extension.model()?.call({ promptId: 'summary.view', parameters: { view: 'a view' } }, context, new AbortController().signal);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ result: 'success', detail: { ai: { tokensIn: 12, tokensOut: 5, cacheReadTokens: 300, cacheWriteTokens: 40 } } });
    } finally {
      failureBody = undefined;
    }
  });

  it('logs nothing for a call that succeeds', async () => {
    const { logged, written, answer } = await callWith(200);
    expect(answer).toMatchObject({ status: 'ok' });
    expect([logged, written]).toEqual([[], []]);
  });

  it('leaves the answer as it was, and writes nothing to the process output, when no logger was handed over', async () => {
    status = 500;
    const written: string[] = [];
    const capture = (chunk: string | Uint8Array): boolean => (written.push(String(chunk)), true);
    vi.spyOn(process.stdout, 'write').mockImplementation(capture as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture as typeof process.stderr.write);
    try {
      const extension = createEnterpriseExtension({ modelBaseUrl: baseUrl });
      await extension.configure?.({ ...SETTINGS, max_retries: 0 }, { ONLY_IN_THE_START_ENV: 'SENTINEL-KEY' });
      extension.createAuditSink?.(SINK_CONTEXT);
      const answer = await extension.model()?.call({ promptId: 'summary.view', parameters: { view: 'x' } }, context, new AbortController().signal);
      expect(answer).toMatchObject({ status: 'failed', code: 'provider-error' });
      expect(written).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      status = 200;
    }
  });

  it('leaves the answer as it was when the logger throws', async () => {
    const { answer, written } = await callWith(500, undefined, { warn: () => { throw new Error('SENTINEL-WRITE'); } });
    expect(answer).toMatchObject({ status: 'failed', code: 'provider-error' });
    expect(written).toEqual([]);
  });

  it('logs only the fixed fields of a failure record that carries more', () => {
    const logged: Record<string, unknown>[] = [];
    const record = { code: 'rejected' as const, status: 401, errorType: 'authentication_error', key: 'SENTINEL-KEY', prompt: 'SENTINEL-PROMPT', question: 'SENTINEL-QUESTION' };
    createFailureReporter(() => ({ warn: (fields) => void logged.push({ ...fields }) }))(record);
    expect(logged).toEqual([{ event: 'ai.provider_failure', code: 'rejected', status: 401, errorType: 'authentication_error' }]);
  });
});

describe('the planner of the extension', () => {
  it('is absent until the model is configured and the audit sink is mounted, then plans through the model', async () => {
    const extension = createEnterpriseExtension({ modelBaseUrl: baseUrl });
    expect(extension.askPlanner?.()).toBeUndefined();
    await extension.configure?.(SETTINGS, { ONLY_IN_THE_START_ENV: 'key-from-the-start-environment' });
    expect(extension.askPlanner?.()).toBeUndefined();
    extension.createAuditSink?.(SINK_CONTEXT);
    const planner = extension.askPlanner?.();
    expect(planner?.availability()).toEqual({ available: true });
  });
});
