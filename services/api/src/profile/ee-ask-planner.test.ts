import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AiMappingView, AskPlan, AuditEvent } from '@neburyx/contracts';
import { createEnterpriseExtension } from '@neburyx/ee-ask';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { communitySeams } from '../seams/community-seams.js';
import { LISTED_PLAN_EXPIRY, LISTED_PLAN_ID, createListPlanStore } from '../testing/list-plan-store.js';
import { startSearchApp } from '../testing/search-app.js';

const events: AuditEvent[] = [];
vi.mock('@neburyx/ee-audit', () => ({ createAuditSink: () => ({ sink: { record: async (event: AuditEvent) => void events.push(event) }, close: async () => undefined }) }));

const QUESTION = 'which are the same as W-001?';
const SINK_CONTEXT = { databaseUrl: 'postgres://app@db.example.test:5432/neburyx', poolSize: 1, connectionTimeoutMs: 100, statementTimeoutMs: 100, queryTimeoutMs: 100, newId: () => 'id', onConnectionError: () => undefined };
const SETTINGS = { preview: true, provider: 'anthropic' as const, model: 'claude-sonnet-5-5', key: { env: 'PLANNER_TEST_KEY' }, timeout_ms: 5_000, max_retries: 0 };
const VIEW: AiMappingView = { types: [{ name: 'widget', kind: 'entity', properties: [] }, { name: 'attr_type', kind: 'entity', properties: [] }, { name: 'attr_link', kind: 'relationship', properties: [], ends: [{ from: 'widget', to: 'attr_type', timed: false }] }] };
const PLAN: AskPlan = { kind: 'plan', templateId: 'shared-attribute', templateVersion: 1, params: { ref: { entityType: 'widget', stableId: '‹widget#1›' }, attributeType: 'attr_type', via: 'attr_link' }, rationale: 'Records that share an attribute.' };

let server: Server;
let baseUrl = '';
let status = 200;
let replyText = JSON.stringify(PLAN);
const received: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(status === 200 ? { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: replyText }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4 } } : { type: 'error', error: { type: 'api_error', message: 'SENTINEL-BODY' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function startPlanning(options: { readonly configure?: boolean; readonly mount?: boolean; readonly previewOn?: boolean } = {}) {
  events.length = 0;
  received.length = 0;
  const extension = createEnterpriseExtension({ modelBaseUrl: baseUrl, planStore: createListPlanStore() });
  if (options.configure !== false) await extension.configure?.(SETTINGS, { PLANNER_TEST_KEY: 'SENTINEL-KEY' }, VIEW);
  if (options.mount !== false) extension.createAuditSink?.(SINK_CONTEXT);
  const rig = await startSearchApp({ appOptions: { extension, previewOn: options.previewOn ?? true, seams: communitySeams() } });
  const post = (payload: unknown) => rig.app.inject({ method: 'POST', url: '/v1/ask/plan', payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
  return { ...rig, post };
}

async function confirmed(post: Awaited<ReturnType<typeof startPlanning>>['post']) {
  const shown = (await post({ message: QUESTION, sourceId: 'demo' })).json();
  return post({ message: QUESTION, sourceId: 'demo', send: true, previewHash: shown.previewHash });
}

describe('the plan endpoint with the planner of the real extension', () => {
  it('answers the plan the model gave, sends the model only the previewed text, and audits the call', async () => {
    status = 200;
    replyText = JSON.stringify(PLAN);
    const { post, app } = await startPlanning();
    const answer = await confirmed(post);
    const hydrated = JSON.parse(JSON.stringify(PLAN).replace('‹widget#1›', 'W-001')) as AskPlan;
    expect([answer.statusCode, answer.json()]).toEqual([200, { plan: hydrated, planId: LISTED_PLAN_ID, expiresAt: LISTED_PLAN_EXPIRY.toISOString() }]);
    expect(received).toHaveLength(1);
    expect(received[0]).toContain('‹widget#1›');
    expect(received[0]).not.toContain('W-001');
    expect(answer.body).not.toContain('SENTINEL');
    expect(events.filter((event) => event.action === 'ask.plan')).toEqual([expect.objectContaining({ result: 'success', sourceId: 'demo', detail: { ai: expect.objectContaining({ promptId: 'ask.plan', tokensIn: 3, tokensOut: 4 }) } })]);
    await app.close();
  });

  it('answers an unsupported plan, as it came, for a reply that is not a plan', async () => {
    status = 200;
    replyText = 'a free text answer';
    const { post, app } = await startPlanning();
    expect((await confirmed(post)).json()).toEqual({ plan: { kind: 'unsupported', reason: 'invalid-plan' } });
    await app.close();
  });

  it('leaves the Community default, and answers ASK_UNSUPPORTED, while the model is not configured or the audit sink is not mounted', async () => {
    for (const options of [{ configure: false }, { mount: false }]) {
      const { post, app } = await startPlanning(options);
      const answer = await post({ message: QUESTION, sourceId: 'demo' });
      expect([answer.statusCode, answer.json().error.code, answer.json().error.details]).toEqual([422, 'ASK_UNSUPPORTED', { reason: 'not-in-this-edition' }]);
      expect(received).toEqual([]);
      await app.close();
    }
  });

  it('refuses and audits when the preview is off, and makes no model call', async () => {
    const { post, app } = await startPlanning({ previewOn: false });
    const answer = await post({ message: QUESTION, sourceId: 'demo' });
    expect([answer.statusCode, answer.json().error.details]).toEqual([403, { reason: 'ai-preview-off' }]);
    expect(received).toEqual([]);
    await app.close();
  });

  it('answers INTERNAL_ERROR, with no model text in the answer, when the model call fails', async () => {
    status = 500;
    const { post, app } = await startPlanning();
    const answer = await confirmed(post);
    expect([answer.statusCode, answer.json().error.code]).toEqual([500, 'INTERNAL_ERROR']);
    expect(answer.body).not.toMatch(/SENTINEL/);
    expect(events.filter((event) => event.action === 'ask.plan')).toEqual([expect.objectContaining({ result: 'failed' })]);
    status = 200;
    await app.close();
  });
});
