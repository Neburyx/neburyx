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
let baseUrl: string;
const authorizations: (string | undefined)[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    request.resume();
    request.on('end', () => {
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
