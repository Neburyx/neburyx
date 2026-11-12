import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEvent, AuditSink } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnthropicProvider } from './anthropic.js';
import { createAuditedModelCall, type AuditedCallContext } from './audited.js';
import { configureAsk, type AskConfiguration } from './configure.js';
import type { ModelRequest, PromptId } from './provider.js';
import { CONFORMANCE_CASES, type ConformanceScenario } from './testing/conformance.js';

const KEY = 'conformance-key-1234567890';
const sha256Of = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

type Reply = (response: ServerResponse) => void;

const json = (status: number, body: unknown): Reply => (response) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const message = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  content: [{ type: 'text', text: 'A synthetic answer.' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 34 },
  ...extra,
});

const SCENARIOS: Readonly<Record<ConformanceScenario, Reply>> = {
  'ok-known-usage': json(200, message()),
  'ok-unknown-usage': json(200, message({ usage: undefined })),
  refused: json(200, message({ stop_reason: 'refusal', content: [] })),
  timeout: () => undefined,
  'rate-limited': json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }),
  rejected: json(401, { type: 'error', error: { type: 'authentication_error', message: 'no' } }),
  'provider-error': json(500, { type: 'error', error: { type: 'api_error', message: 'broken' } }),
  unreachable: (response) => response.destroy(),
  'bad-reply': json(200, { unexpected: true }),
  truncated: json(200, message({ stop_reason: 'max_tokens' })),
  'model-asks-for-a-tool': json(200, message({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'lookup', input: {} }] })),
};

let server: Server;
let baseUrl: string;
let next: Reply = SCENARIOS['ok-known-usage'];
let bodies: string[] = [];
const sockets = new Set<Socket>();
const folder = mkdtempSync(join(tmpdir(), 'ee-ask-conformance-'));

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      next(response);
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

async function configurationWith(prompts: Record<string, string> = {}): Promise<AskConfiguration> {
  const { configuration, outcome } = await configureAsk({ preview: true, provider: 'anthropic', model: 'claude-sonnet-5-5', key: { env: 'STUB_KEY' }, timeout_ms: 1_000, max_retries: 0, prompts }, { STUB_KEY: KEY });
  if (configuration === undefined) throw new Error(JSON.stringify(outcome));
  return configuration;
}

describe('the conformance suite on the Anthropic provider, over a stub server', () => {
  describe.each(CONFORMANCE_CASES)('$name', (conformanceCase) => {
    it('passes', async () => {
      const configuration = await configurationWith();
      bodies = [];
      await conformanceCase.run({
        provider: createAnthropicProvider({ configuration, env: { STUB_KEY: KEY }, baseUrl }),
        registry: configuration.registry,
        arrange: (scenario) => {
          next = SCENARIOS[scenario];
        },
        callsMade: () => bodies.length,
      });
    });
  });
});

const CONTEXT: AuditedCallContext = { actorId: '01939999-0000-7000-8000-0000000000aa', actorRole: 'investigator', traceId: 'tr-1' };
const REQUESTS: Readonly<Record<PromptId, ModelRequest>> = {
  'ask.plan': { promptId: 'ask.plan', parameters: { catalog: 'T1, T2', question: 'QUESTION-MARKER who is here?' } },
  'summary.view': { promptId: 'summary.view', parameters: { view: 'VIEW-MARKER a view' } },
  'assistant.route': { promptId: 'assistant.route', parameters: { message: 'MESSAGE-MARKER hello', view: 'VIEW-MARKER a view' } },
};

function recordingSink(): { readonly sink: AuditSink; readonly events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return { events, sink: { record: (event) => (events.push(event), Promise.resolve()) } };
}

async function audited(configuration: AskConfiguration) {
  const recorded = recordingSink();
  const call = createAuditedModelCall({ provider: createAnthropicProvider({ configuration, env: { STUB_KEY: KEY }, baseUrl }), configuration, sink: recorded.sink });
  return { call, ...recorded };
}

describe('the provider behind the audited call', () => {
  describe.each([['the built-in text', false], ['an operator override', true]] as const)('with %s', (_name, override) => {
    it.each(['ask.plan', 'summary.view', 'assistant.route'] as const)('audits the template hash of %s and no hash of the filled text or of the request body', async (id) => {
      const overrides: Record<string, string> = {};
      let templateBytes: string | undefined;
      if (override) {
        const placeholders = { 'ask.plan': '{{catalog}} {{question}}', 'summary.view': '{{view}}', 'assistant.route': '{{message}} {{view}}' }[id];
        templateBytes = `Override text for the test. ${placeholders}\n`;
        const path = join(folder, `${id}.txt`);
        writeFileSync(path, templateBytes);
        overrides[id] = path;
      }
      const configuration = await configurationWith(overrides);
      const { call, events } = await audited(configuration);
      next = SCENARIOS['ok-known-usage'];
      bodies = [];
      const answer = await call.call(REQUESTS[id], CONTEXT, new AbortController().signal);
      expect(answer.status).toBe('ok');
      expect(bodies).toHaveLength(1);

      const resolved = configuration.registry.resolve(id, REQUESTS[id].parameters);
      expect(events).toHaveLength(1);
      expect(events[0]?.detail).toMatchObject({ ai: { promptId: id, promptSha256: resolved.record.sha256 } });
      if (templateBytes !== undefined) expect(resolved.record.sha256).toBe(sha256Of(templateBytes));

      const sent = JSON.parse(bodies[0] ?? '') as { messages: { content: string }[] };
      expect(sent.messages[0]?.content).toBe(resolved.text);
      const recorded = JSON.stringify(events);
      for (const hash of [sha256Of(resolved.text), sha256Of(bodies[0] ?? ''), sha256Of(sent.messages[0]?.content ?? '')]) {
        expect(recorded).not.toContain(hash);
        expect(recorded).not.toContain(hash.toUpperCase());
      }
      expect(recorded).not.toMatch(/MARKER|A synthetic answer/);
    });
  });

  it('records one failed event for a stub that never replies, and one refused event for a refusal, and the answers carry no text', async () => {
    const configuration = await configurationWith();
    const { call, events } = await audited(configuration);
    next = SCENARIOS.timeout;
    const timedOut = await call.call(REQUESTS['summary.view'], CONTEXT, new AbortController().signal);
    expect(timedOut).toMatchObject({ status: 'failed', code: 'timeout' });
    next = SCENARIOS.refused;
    const refused = await call.call(REQUESTS['summary.view'], CONTEXT, new AbortController().signal);
    expect(refused.status).toBe('refused');
    expect(events.map((event) => event.result)).toEqual(['failed', 'refused']);
    for (const answer of [timedOut, refused]) expect(answer).not.toHaveProperty('text');
  });

  it('records the model the reply names when a fallback answered', async () => {
    const { call, events } = await audited(await configurationWith());
    next = json(200, message({ model: 'claude-haiku-5-5' }));
    await call.call(REQUESTS['summary.view'], CONTEXT, new AbortController().signal);
    expect(events[0]?.detail).toMatchObject({ ai: { modelRef: 'claude-haiku-5-5' } });
  });
});
