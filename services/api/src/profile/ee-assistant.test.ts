import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rmSync } from 'node:fs';
import { assistantTurnAnswerSchema, type AuditEvent, type AuditSink } from '@neburyx/contracts';
import { createEnterpriseExtension } from '@neburyx/ee-ask';
import fc from 'fast-check';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { makeAskFolder, removeAskFolders } from '../testing/ask-folder.js';
import { createAuditQueue } from '../audit/queue.js';
import { fileQueryDepsOf } from '../gate/file-query.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { exportWebRoot, startExportRig } from '../testing/export-rig.js';
import { plainNode, plainRelationship } from '../testing/normalize-fixtures.js';

afterAll(() => {
  rmSync(exportWebRoot, { recursive: true, force: true });
  removeAskFolders();
});

interface Stub {
  readonly server: Server;
  readonly url: string;
  readonly bodies: string[];
}

async function modelStub(reply: string | (() => string)): Promise<Stub> {
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      bodies.push(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: typeof reply === 'string' ? reply : reply() }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}

const ENV = { NEBURYX_ASK_API_KEY: 'a-test-key' };
const INTENTS = { widgetById: { parameters: ['id'], template: 'entity', settings: { ref: { entityType: 'widget', stableId: '$id' } } }, queryById: { parameters: ['id'], query: 'MATCH (n:Widget {widgetId: $id}) RETURN n' }, sharedGadget: { parameters: ['id'], template: 'shared-attribute', settings: { ref: { entityType: 'widget', stableId: '$id' }, attributeType: 'gadget', via: 'MADE_FROM' } } };
const widgetNode = (id: string) => ({ $type: 'node', elementId: `4:s:${id}`, labels: ['Widget'], properties: { widgetId: id, ownerName: 'Ana Silva' } });

async function assistantRig(options: { reply?: string | (() => string); features?: { ask: boolean; summary: boolean; assistant: boolean }; modelAudit?: AuditSink; fileQuery?: ExecuteOutcome; answer?: (call: ExecuteCall) => ExecuteOutcome | undefined } = {}) {
  const stub = await modelStub(options.reply ?? '{"route":"refuse","cause":"verdict"}');
  const extension = createEnterpriseExtension({ modelBaseUrl: stub.url });
  const features = options.features ?? { ask: false, summary: false, assistant: true };
  const configured = await extension.configure?.({}, { ...ENV, NEBURYX_ASK_MAPPING_FOLDER: makeAskFolder(['demo'], INTENTS) }, { sourceIds: ['demo'], features });
  expect(configured).toEqual({ ok: true });
  const events: AuditEvent[] = [];
  extension.attachAudit?.(options.modelAudit ?? { record: async (event) => void events.push(event) });
  const rig = await startExportRig({ extension, previewOn: true, directAudit: true, fileQueries: fileQueryDepsOf(() => extension.askFolder()), ...(options.fileQuery === undefined && options.answer === undefined ? {} : { answer: (call) => (call.templateId === 'file-query' ? options.fileQuery : options.answer?.(call)) }) });
  const investigation = await rig.open();
  const body = { sourceId: 'demo', investigationId: investigation.id, message: 'Is this person guilty?', viewElementKeys: [] };
  const post = (payload: unknown = body) => rig.app.inject({ method: 'POST', url: '/v1/assistant/turns', payload: payload as object });
  const stop = async (): Promise<void> => {
    await rig.stop();
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  };
  return { post, body, stub, events, rig, stop, extension };
}

describe('POST /v1/assistant/turns in the real application, with the assistant alone on and no Enterprise profile', () => {
  it('answers a turn through the assistant: one model call, a fixed refusal, and the status says the assistant is available with its limit', async () => {
    const rig = await assistantRig();
    const answer = await rig.post();
    expect(answer.statusCode).toBe(200);
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ status: 'answered', route: 'refuse', cause: 'verdict' });
    expect(rig.stub.bodies).toHaveLength(1);
    expect(rig.events.filter((event) => event.action === 'assistant.route')).toHaveLength(1);
    const status = await rig.rig.app.inject({ url: '/v1/ai/status' });
    expect(status.json()).toEqual({ ask: { available: false }, summary: { available: false }, assistant: { available: true, messageWords: 1000 } });
    await rig.stop();
  });

  it('answers NOT_FOUND for an investigation that is not the caller’s, with no model call', async () => {
    const rig = await assistantRig();
    const answer = await rig.post({ ...rig.body, investigationId: '01939999-0000-7000-8000-0000000000ff' });
    expect(answer.statusCode).toBe(404);
    expect(answer.json().error).toMatchObject({ code: 'NOT_FOUND' });
    expect(rig.stub.bodies).toHaveLength(0);
    await rig.stop();
  });

  it('answers NOT_FOUND for a source the caller cannot read, with no model call', async () => {
    const rig = await assistantRig();
    const answer = await rig.post({ ...rig.body, sourceId: 'elsewhere' });
    expect(answer.statusCode).toBe(404);
    expect(rig.stub.bodies).toHaveLength(0);
    await rig.stop();
  });

  it('refuses a message of 1,001 words with the count and the limit and sends nothing', async () => {
    const rig = await assistantRig();
    const answer = await rig.post({ ...rig.body, message: Array.from({ length: 1001 }, () => 'w').join(' ') });
    expect(assistantTurnAnswerSchema.parse(answer.json())).toEqual({ status: 'too-long', words: 1001, limit: 1000 });
    expect(rig.stub.bodies).toHaveLength(0);
    await rig.stop();
  });

  it.each([['an unknown member', { extra: 1 }], ['no keys of the view', { viewElementKeys: undefined }], ['an empty message', { message: '' }]])('refuses a body with %s as INVALID_REQUEST', async (_name, over) => {
    const rig = await assistantRig();
    const answer = await rig.post({ ...rig.body, ...over });
    expect(answer.statusCode).toBe(400);
    expect(answer.json().error).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(rig.stub.bodies).toHaveLength(0);
    await rig.stop();
  });
});

describe('the ask route through the real gate', () => {
  it('runs the intent once through the gate as the caller and answers Ask’s result with one event and no value in it', async () => {
    const rig = await assistantRig({ reply: '{"route":"ask","intent":"widgetById","entities":{"id":"W-1"}}' });
    const before = rig.rig.executor.calls.filter((call) => call.templateId === 'entity-load').length;
    const answer = await rig.post({ ...rig.body, message: 'Show widget W-1' });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({ status: 'answered', route: 'ask', answer: { answered: { intent: 'widgetById', entities: { id: 'W-1' }, outcome: 'complete', result: { templateId: 'entity' } } } });
    expect(rig.rig.executor.calls.filter((call) => call.templateId === 'entity-load')).toHaveLength(before + 1);
    const events = rig.rig.events.filter((event) => event.action === 'assistant.ask');
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(/W-1|Show widget/);
    await rig.stop();
  });

  it('answers Ask’s nothing-found refusal for an anchor the source does not hold, after one read', async () => {
    const rig = await assistantRig({ reply: '{"route":"ask","intent":"widgetById","entities":{"id":"W-404"}}' });
    const answer = await rig.post({ ...rig.body, message: 'Show widget W-404' });
    expect(answer.json()).toMatchObject({ status: 'answered', route: 'ask', answer: { refused: { cause: 'nothing-found' } } });
    await rig.stop();
  });

  it('refuses a router reply that is not a route and runs nothing on the source', async () => {
    const rig = await assistantRig({ reply: 'MATCH (n) DETACH DELETE n' });
    const before = rig.rig.executor.calls.length;
    const answer = await rig.post();
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ status: 'answered', route: 'refuse', cause: 'unplaced' });
    expect(rig.rig.executor.calls).toHaveLength(before);
    await rig.stop();
  });
});

describe('the ask route and hostile values the router names', () => {
  it('never puts a value of the router into a statement text, whatever it holds, and answers 200 or a refusal of the product', async () => {
    const hostile = { value: '' };
    const rig = await assistantRig({ reply: () => JSON.stringify({ route: 'ask', intent: 'widgetById', entities: { id: hostile.value } }) });
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.string({ maxLength: 120 }), fc.constantFrom("W-1' OR 1=1 //", '}) DETACH DELETE n //', '$id', '`; CALL dbms.shutdown()', 'W-1\u0000')), async (value) => {
        hostile.value = value;
        const before = rig.rig.executor.calls.length;
        const answer = await rig.post({ ...rig.body, message: 'Show a widget' });
        expect([200, 400]).toContain(answer.statusCode);
        if (answer.statusCode === 200) assistantTurnAnswerSchema.parse(answer.json());
        const text = rig.rig.executor.calls.slice(before).map((call) => call.cypher).join('\n');
        if (value.length >= 4) expect(text).not.toContain(value);
      }),
      { numRuns: 60 },
    );
    await rig.stop();
  });
});

describe('a file query through the real gate in the running application', () => {
  const REPLY = '{"route":"ask","intent":"queryById","entities":{"id":"W-1"}}';

  it('runs the stored query once, read-only, with the value as its only parameter, and answers its rows with a step and a coverage line', async () => {
    const rig = await assistantRig({ reply: REPLY, fileQuery: { status: 'rows', rows: [{ n: widgetNode('W-1') }, { n: widgetNode('W-2') }] } });
    const before = rig.rig.executor.calls.length;
    const answer = await rig.post({ ...rig.body, message: 'Query widget W-1' });
    expect(answer.json()).toMatchObject({ status: 'answered', route: 'ask', answer: { answered: { intent: 'queryById', result: { templateId: 'file-query' } } }, step: { intent: 'queryById', rows: 2 } });
    const calls = rig.rig.executor.calls.slice(before).filter((call) => call.templateId === 'file-query');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ accessMode: 'READ', parameters: { id: 'W-1' } });
    expect(Object.keys(calls[0]?.parameters ?? {})).toEqual(['id']);
    await rig.stop();
  });

  it('answers Ask’s nothing-found refusal when the query returns no row', async () => {
    const rig = await assistantRig({ reply: REPLY, fileQuery: { status: 'rows', rows: [] } });
    const answer = await rig.post({ ...rig.body, message: 'Query widget W-1' });
    expect(answer.json()).toMatchObject({ status: 'answered', route: 'ask', answer: { refused: { cause: 'nothing-found' } } });
    await rig.stop();
  });

  it('refuses a query whose rows are not nodes and relationships of the mapping with INVALID_REQUEST and the reason file-query-result', async () => {
    const rig = await assistantRig({ reply: REPLY, fileQuery: { status: 'rows', rows: [{ n: 'not a node' }] } });
    const answer = await rig.post({ ...rig.body, message: 'Query widget W-1' });
    expect(answer.statusCode).toBe(400);
    expect(answer.json().error).toMatchObject({ code: 'INVALID_REQUEST', details: { reason: 'file-query-result' } });
    await rig.stop();
  });
});

describe('a heavy stop and its continue through the real gate in the running application, with Ask switched off', () => {
  const REPLY = '{"route":"ask","intent":"sharedGadget","entities":{"id":"W-1"}}';
  const widget = (id: string) => plainNode(['Widget'], { widgetId: id, ownerName: 'Ana Silva' }, `4:s:${id}`);
  const gadget = plainNode(['Gadget'], { gadgetId: 'GT-1' }, '4:s:GT-1');
  const page = (call: ExecuteCall): ExecuteOutcome | undefined => {
    if (call.templateId !== 'shared-attribute') return undefined;
    const row = (match: string) => ({ a: widget('W-1'), b: widget(match), xs: [gadget], ras: [plainRelationship('MADE_FROM', widget('W-1'), gadget, { linkId: 'L-1' }, '5:s:L-1')], rbs: [plainRelationship('MADE_FROM', widget(match), gadget, { linkId: `L-${match}` }, `5:s:L-${match}`)], skipped: false, bounded: false, shared: 1, evidenceCut: false });
    return { status: 'rows', rows: [row('W-2'), row('W-3')] };
  };
  const probe = (matches: number) => (call: ExecuteCall): ExecuteOutcome | undefined => (call.templateId === 'shared-attribute-count' ? { status: 'rows', rows: [{ matches, anchorBounded: false, skipped: false }] } : page(call));

  it('stops a read the source counts above its threshold with a lower-bound figure and a token, reads no page, and continues it once with that token and no model call', async () => {
    const rig = await assistantRig({ reply: REPLY, answer: probe(1_000_000) });
    const before = rig.rig.executor.calls.length;
    const stopped = (await rig.post({ ...rig.body, message: 'Which widgets share a gadget with W-1?' })).json();
    expect(stopped).toMatchObject({ status: 'answered', route: 'ask', answer: { answered: { intent: 'sharedGadget', result: { result: { status: 'heavy', estimate: { quality: 'lowerBound' } } } } } });
    expect(stopped).not.toHaveProperty('step');
    expect(rig.rig.executor.calls.slice(before).some((call) => call.templateId === 'shared-attribute')).toBe(false);
    const token = stopped.answer.answered.continueToken;
    expect(typeof token).toBe('string');
    const modelCalls = rig.stub.bodies.length;
    const continued = (await rig.post({ sourceId: 'demo', investigationId: rig.body.investigationId, viewElementKeys: [], continue: { intent: 'sharedGadget', entities: { id: 'W-1' }, continueToken: token } })).json();
    expect(continued).toMatchObject({ status: 'answered', route: 'ask', answer: { answered: { intent: 'sharedGadget', outcome: 'complete', result: { templateId: 'shared-attribute', result: { status: 'ok' } } } } });
    expect(continued.answer.answered.result.result.matchIds.map((entry: { stableId: string }) => entry.stableId)).toEqual(['W-2', 'W-3']);
    expect(continued.answer.answered.summary.citations.length).toBeGreaterThan(0);
    expect(continued.answer.answered).not.toHaveProperty('continueToken');
    expect(continued).toMatchObject({ step: { intent: 'sharedGadget', rows: expect.any(Number) }, coverage: expect.stringContaining('matches shown') });
    expect(rig.stub.bodies).toHaveLength(modelCalls);
    expect(rig.rig.executor.calls.slice(before).some((call) => call.templateId === 'shared-attribute')).toBe(true);
    const altered = await rig.post({ sourceId: 'demo', investigationId: rig.body.investigationId, viewElementKeys: [], continue: { intent: 'sharedGadget', entities: { id: 'W-2' }, continueToken: token } });
    expect(altered.json()).toMatchObject({ status: 'continue-invalid' });
    await rig.stop();
  });
});

describe('the view route and a continue in the running application', () => {
  it('answers the view route with the fixed not-answered turn and reads nothing from the source', async () => {
    const rig = await assistantRig({ reply: '{"route":"view"}' });
    const before = rig.rig.executor.calls.length;
    const answer = await rig.post();
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ status: 'not-answered', route: 'view' });
    expect(rig.rig.executor.calls).toHaveLength(before);
    await rig.stop();
  });

  it('answers continue-invalid for a token the application did not issue, with no model call and no read, and audits the refusal', async () => {
    const rig = await assistantRig();
    const before = rig.rig.executor.calls.length;
    const token = `${'1'.repeat(13)}.${'a'.repeat(64)}`;
    const answer = await rig.post({ sourceId: 'demo', investigationId: rig.body.investigationId, viewElementKeys: [], continue: { intent: 'widgetById', entities: { id: 'W-1' }, continueToken: token } });
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ status: 'continue-invalid' });
    expect(rig.stub.bodies).toHaveLength(0);
    expect(rig.rig.executor.calls).toHaveLength(before);
    expect(rig.rig.events.filter((event) => event.action === 'assistant.continue').map((event) => event.result)).toEqual(['refused']);
    await rig.stop();
  });
});

describe('a turn when the audit store is down, blocked or full, through the queue of the application', () => {
  const SENTINEL = 'SENTINEL-MESSAGE-TEXT';

  function queueOver(store: AuditSink, size = 100) {
    const logs: Record<string, unknown>[] = [];
    const queue = createAuditQueue({ sinks: [{ name: 'test', sink: store }], settings: { queueSize: size, retryLimit: 0, retryWaitMs: 10, writeTimeoutMs: 1000 }, logger: { warn: (fields) => void logs.push(fields) } });
    return { queue, logs };
  }

  it('answers a turn the same, at once, when the store fails every write, counts the failures and logs ids only', async () => {
    const down = queueOver({ record: () => Promise.reject(new Error('the store is down')) });
    const rig = await assistantRig({ modelAudit: down.queue.sink, reply: '{"route":"refuse","cause":"verdict"}' });
    const answer = await rig.post({ ...rig.body, message: SENTINEL });
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ status: 'answered', route: 'refuse', cause: 'verdict' });
    await vi.waitFor(() => expect(down.queue.counts().failed).toBeGreaterThan(0));
    expect(JSON.stringify(down.logs)).not.toContain(SENTINEL);
    expect(down.logs.length).toBeGreaterThan(0);
    await rig.stop();
  });

  it('answers many turns without waiting for a store that never answers, and drops what does not fit, counted', async () => {
    const blocked = queueOver({ record: () => new Promise<void>(() => undefined) }, 1);
    const rig = await assistantRig({ modelAudit: blocked.queue.sink });
    for (let turn = 0; turn < 4; turn += 1) {
      const answer = await rig.post({ ...rig.body, message: SENTINEL });
      expect(answer.statusCode).toBe(200);
    }
    expect(blocked.queue.counts().dropped).toBeGreaterThan(0);
    expect(JSON.stringify(blocked.logs)).not.toContain(SENTINEL);
    await rig.stop();
  });
});

describe('POST /v1/assistant/turns when the assistant is off', () => {
  it('answers 403 with the reason ai-off, reads nothing of the body and calls no model', async () => {
    const rig = await assistantRig({ features: { ask: true, summary: false, assistant: false } });
    const answer = await rig.post({ nonsense: true });
    expect(answer.statusCode).toBe(403);
    expect(answer.json().error).toMatchObject({ code: 'ACCESS_DENIED', details: { reason: 'ai-off' } });
    expect(rig.stub.bodies).toHaveLength(0);
    const status = await rig.rig.app.inject({ url: '/v1/ai/status' });
    expect(status.json().assistant).toEqual({ available: false });
    await rig.stop();
  });
});
