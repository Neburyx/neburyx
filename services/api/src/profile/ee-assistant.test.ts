import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSISTANT_REFUSAL_SENTENCES, assistantThreadResponseSchema, assistantTurnAnswerSchema, type AuditCounts, type AuditEvent, type AuditSink, type RecordJob, type RecordQueue } from '@neburyx/contracts';
import { createEnterpriseExtension, createMemoryAssistantRunStore, createMemoryAssistantPendingStore, createMemoryAssistantThreadStore, sealToken } from '@neburyx/ee-ask';
import fc from 'fast-check';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { makeAskFolder, removeAskFolders } from '../testing/ask-folder.js';
import { createAuditQueue, createEventQueue } from '../audit/queue.js';
import { LOCAL_IDENTITY } from '../testing/app-store.js';
import { fileQueryDepsOf } from '../gate/file-query.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { exportWebRoot, startExportRig, type ExportRigOptions } from '../testing/export-rig.js';
import { plainNode, plainRelationship } from '../testing/normalize-fixtures.js';
import { createAgentScript } from '../testing/agent-script.js';

type AssistantRunStore = ReturnType<typeof createMemoryAssistantRunStore>;
type AssistantThreadStore = ReturnType<typeof createMemoryAssistantThreadStore>;

afterAll(() => {
  rmSync(exportWebRoot, { recursive: true, force: true });
  removeAskFolders();
});

interface Stub {
  readonly server: Server;
  readonly url: string;
  readonly bodies: string[];
}

async function modelStub(reply: string | (() => string), hang = false): Promise<Stub> {
  const bodies: string[] = [];
  const script = createAgentScript();
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      bodies.push(body);
      if (hang) return;
      response.writeHead(200, { 'content-type': 'application/json' });
      const content = script.content(body, () => (typeof reply === 'string' ? reply : reply()));
      response.end(JSON.stringify({ id: `msg_${bodies.length}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason: content.some((block) => block['type'] === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}

/** The replies of a scripted turn in order, the last one repeated: the router's, then each read of the agent, `{"done":true}` and the answer. */
const sequenceOf = (...replies: string[]) => {
  let next = 0;
  return () => replies[Math.min(next++, replies.length - 1)] ?? '{"done":true}';
};
const DONE = '{"done":true}';
/** The agent's answer to its read of widget W-1, citing that read's element. */
const ANSWER_OF_W1 = JSON.stringify({ sentences: [{ text: 'Widget W-1 of Ana Silva is listed.', cites: ['r1'] }] });

/** A key of the view that is well formed and holds a canary, since a key that is not well formed is refused before any model sees the message. */
const CANARY_KEY = JSON.stringify(['node', 'demo', 'widget', 'key-canary-9']);
const ENV = { NEBURYX_ASK_API_KEY: 'a-test-key' };
const INTENTS = { widgetById: { parameters: ['id'], template: 'entity', settings: { ref: { entityType: 'widget', stableId: '$id' } } }, queryById: { parameters: ['id'], query: 'MATCH (n:Widget {widgetId: $id}) RETURN n' }, sharedGadget: { parameters: ['id'], template: 'shared-attribute', settings: { ref: { entityType: 'widget', stableId: '$id' }, attributeType: 'gadget', via: 'MADE_FROM' } } };
const widgetNode = (id: string) => ({ $type: 'node', elementId: `4:s:${id}`, labels: ['Widget'], properties: { widgetId: id, ownerName: 'Ana Silva' } });

/** An answer with the tokens of its choices made alike: each carries the time it was made, so two answers to one question differ in them and in nothing else. */
const sameButTokens = (answer: unknown): unknown => JSON.parse(JSON.stringify(answer, (key, value: unknown) => (key === 'choiceToken' ? 'token' : value)));

/** The file of a summary token key the extension reads, owner-only as it requires. */
function tokenKeyFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'nbx-assistant-key-')), 'token.key');
  writeFileSync(file, `${'7'.repeat(64)}\n`);
  chmodSync(file, 0o600);
  return file;
}

async function assistantRig(options: { maxSteps?: number; withSummary?: boolean; principal?: ExportRigOptions['principal']; unexportableNode?: string; reply?: string | (() => string); hang?: boolean; runStore?: AssistantRunStore; threadStore?: AssistantThreadStore; principalId?: () => string; logLines?: string[]; recordQueue?: RecordQueue; auditCounts?: () => AuditCounts; requestAudit?: AuditSink; features?: { ask: boolean; summary: boolean; assistant: boolean }; modelAudit?: AuditSink; fileQuery?: ExecuteOutcome; answer?: (call: ExecuteCall) => ExecuteOutcome | Promise<ExecuteOutcome> | undefined } = {}) {
  const stub = await modelStub(options.reply ?? '{"route":"refuse","cause":"verdict"}', options.hang === true);
  const extension = createEnterpriseExtension({ modelBaseUrl: stub.url, assistantRunStore: () => options.runStore ?? createMemoryAssistantRunStore(), assistantThreadStore: () => options.threadStore ?? createMemoryAssistantThreadStore(), assistantPendingStore: () => createMemoryAssistantPendingStore() });
  const features = options.features ?? { ask: false, summary: options.withSummary === true, assistant: true };
  const configured = await extension.configure?.({}, { ...ENV, NEBURYX_ASSISTANT_MAX_STEPS: String(options.maxSteps ?? 1), NEBURYX_ASK_MAPPING_FOLDER: makeAskFolder(['demo'], INTENTS), ...(options.withSummary === true ? { NEBURYX_SUMMARY_TOKEN_KEY_FILE: tokenKeyFile(), NEBURYX_SUMMARY_MAX_INPUT_TOKENS: '100000' } : {}) }, { sourceIds: ['demo'], features });
  expect(configured).toEqual({ ok: true });
  const events: AuditEvent[] = [];
  const armed = { open: false };
  const sinkOpened = options.runStore === undefined && options.threadStore === undefined ? undefined : extension.createAuditSink?.({ databaseUrl: 'postgres://app@db.example.test:5432/neburyx', poolSize: 1, connectionTimeoutMs: 100, statementTimeoutMs: 100, queryTimeoutMs: 100, newId: () => randomUUID(), onConnectionError: () => undefined });
  if (options.recordQueue !== undefined) extension.attachRecordQueue?.(options.recordQueue);
  extension.attachAudit?.(options.modelAudit ?? { record: async (event) => void events.push(event) });
  const rig = await startExportRig({ extension, links: ['L-1'], ...(options.principal === undefined ? {} : { principal: options.principal }), ...(options.unexportableNode === undefined ? {} : { unexportableNode: options.unexportableNode }), previewOn: true, directAudit: true, ...(options.logLines === undefined ? {} : { logLines: options.logLines }), ...(options.principalId === undefined ? {} : { principal: () => ({ id: options.principalId?.() }) }), ...(options.auditCounts === undefined ? {} : { auditCounts: options.auditCounts }), ...(options.requestAudit === undefined ? {} : { auditMember: options.requestAudit }), fileQueries: fileQueryDepsOf(() => extension.askFolder()), ...(options.fileQuery === undefined && options.answer === undefined ? {} : { answer: (call) => (call.templateId === 'file-query' ? options.fileQuery : armed.open ? options.answer?.(call) : undefined) }) });
  const investigation = await rig.open();
  armed.open = true;
  const body = { sourceId: 'demo', investigationId: investigation.id, message: 'Is this person guilty?', viewElementKeys: [] };
  const post = (payload: unknown = body) => rig.app.inject({ method: 'POST', url: '/v1/assistant/turns', payload: payload as object });
  const stop = async (): Promise<void> => {
    await rig.stop();
    await sinkOpened?.close();
    stub.server.closeAllConnections();
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

describe('the refusals of the router through the real application', () => {
  const CAUSES = ['verdict', 'raw-query', 'other-source'] as const;
  const MESSAGES = { verdict: 'Is this person guilty of fraud?', 'raw-query': 'MATCH (n) RETURN n', 'other-source': 'Show me the other source instead' } as const;
  const everything = (rig: Awaited<ReturnType<typeof assistantRig>>): AuditEvent[] => [...rig.events, ...rig.rig.events];

  it('hands a refuse reply with extra text beside the cause to the agent after the router’s one repeat, and answers not-answered with none of the model’s words when the agent never calls answer', async () => {
    const rig = await assistantRig({ reply: '{"route":"refuse","cause":"verdict","sentence":"MODEL-WORDS-CANARY"}' });
    const answer = await rig.post();
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ status: 'not-answered', route: 'view' });
    expect(JSON.stringify([answer.json(), everything(rig)])).not.toContain('MODEL-WORDS-CANARY');
    expect(rig.stub.bodies).toHaveLength(3);
    await rig.stop();
  });

  it('hands a message the router cannot place to the agent, and answers not-answered, never the unplaced refusal, when the agent never calls answer', async () => {
    const rig = await assistantRig({ reply: JSON.stringify({ route: 'refuse', cause: 'unplaced' }) });
    const answer = await rig.post({ ...rig.body, message: 'Tell me about the big ones' });
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ status: 'not-answered', route: 'view' });
    expect(rig.stub.bodies.length).toBeGreaterThan(1);
    await rig.stop();
  });

  it.each(CAUSES)('answers the %s refusal with its fixed sentence, closes the turn as refused with no access denial, reads nothing and makes one model call', async (cause) => {
    const rig = await assistantRig({ reply: JSON.stringify({ route: 'refuse', cause }) });
    const before = rig.rig.executor.calls.length;
    const answer = await rig.post({ ...rig.body, message: MESSAGES[cause] });
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ status: 'answered', route: 'refuse', cause, sentence: ASSISTANT_REFUSAL_SENTENCES[cause] });
    const events = everything(rig);
    expect(events.filter((event) => event.action === 'assistant.turn.closed')).toMatchObject([{ result: 'refused', detail: { turn: { outcome: 'refused', modelCalls: 1 } } }]);
    expect(events.some((event) => event.result === 'denied')).toBe(false);
    expect(events.some((event) => event.action === 'assistant.ask')).toBe(false);
    expect(rig.rig.executor.calls.slice(before)).toHaveLength(0);
    expect(rig.stub.bodies).toHaveLength(1);
    await rig.stop();
  });
});

describe('the tool loop through the real application', () => {
  const ROUTE = '{"route":"ask","intent":"widgetById","entities":{"id":"W-1"}}';
  const ANSWER = JSON.stringify({ sentences: [{ text: 'Ana Silva is listed.', cites: ['r1'] }] });
  const everything = (rig: Awaited<ReturnType<typeof assistantRig>>): AuditEvent[] => [...rig.events, ...rig.rig.events];
  const sequence = (...replies: string[]) => {
    let next = 0;
    return () => replies[Math.min(next++, replies.length - 1)] ?? '{"done":true}';
  };
  const entityReads = (rig: Awaited<ReturnType<typeof assistantRig>>) => rig.rig.executor.calls.filter((call) => call.templateId === 'entity-load').length;

  it('asks the model for the next step after the first read, answers its checked sentences when it calls answer, and counts the router call, two agent calls and one step', async () => {
    const rig = await assistantRig({ maxSteps: 4, reply: sequence(ROUTE, '{"done":true}', ANSWER), answer: (call) => (call.templateId === 'entity-load' ? { status: 'rows', rows: [{ n: widgetNode('W-1') }] } : undefined) });
    const answer = await rig.post({ ...rig.body, message: 'Show W-1' });
    expect(answer.json()).toMatchObject({ status: 'answered', route: 'ask', sentences: [{ text: 'Ana Silva is listed.', cites: ['r1'] }], reads: [{ tool: 'widgetById', kind: 'intent', read: true }] });
    expect(rig.stub.bodies).toHaveLength(3);
    expect(everything(rig).filter((event) => event.action === 'assistant.agent')).toHaveLength(2);
    expect(everything(rig).filter((event) => event.action === 'assistant.turn.closed')).toMatchObject([{ detail: { turn: { modelCalls: 3, steps: 1, outcome: 'answered' } } }]);
    await rig.stop();
  });

  it('runs a second read the model asks for through the gate, and counts five model calls and two steps', async () => {
    const rig = await assistantRig({ maxSteps: 4, reply: sequence(ROUTE, '{"tool":"widgetById","values":{"id":"W-2"}}', '{"done":true}', ANSWER), answer: (call) => (call.templateId === 'entity-load' ? { status: 'rows', rows: [{ n: widgetNode('W-2') }] } : undefined) });
    const before = entityReads(rig);
    const answer = await rig.post({ ...rig.body, message: 'Show W-1 and W-2' });
    expect(answer.json()).toMatchObject({ status: 'answered', route: 'ask' });
    expect(entityReads(rig) - before).toBe(2);
    expect(everything(rig).filter((event) => event.action === 'assistant.turn.closed')).toMatchObject([{ detail: { turn: { modelCalls: 4, steps: 2 } } }]);
    await rig.stop();
  });

  it('answers after the steps with sentences that cite the elements the reads returned, checked, with five model calls and two steps', async () => {
    const answerJson = JSON.stringify({ sentences: [{ text: 'Ana Silva appears on two widgets.', cites: ['r1', 'r2'] }] });
    let read = 0;
    const rig = await assistantRig({ maxSteps: 4, reply: sequence(ROUTE, '{"tool":"widgetById","values":{"id":"W-2"}}', '{"done":true}', answerJson), answer: (call) => (call.templateId === 'entity-load' ? { status: 'rows', rows: [{ n: widgetNode(`W-${++read}`) }] } : undefined) });
    const answer = await rig.post({ ...rig.body, message: 'Show W-1 and W-2' });
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ status: 'answered', route: 'ask', steps: 2, calls: 4 });
    const events = everything(rig);
    expect(events.filter((event) => event.action === 'assistant.agent')).toHaveLength(3);
    expect(events.filter((event) => event.action === 'assistant.turn.closed')).toMatchObject([{ detail: { turn: { modelCalls: 4, steps: 2, outcome: 'answered' } } }]);
    expect(JSON.stringify(events)).not.toContain('appears on two widgets');
    await rig.stop();
  });

  it('runs a built-in template the model names by its id as a second read through the gate, and counts two steps', async () => {
    const rig = await assistantRig({ maxSteps: 4, reply: sequence(ROUTE, '{"tool":"entity","values":{"entityType":"widget","stableId":"W-2"}}', '{"done":true}', ANSWER), answer: (call) => (call.templateId === 'entity-load' ? { status: 'rows', rows: [{ n: widgetNode('W-2') }] } : undefined) });
    const before = entityReads(rig);
    const answer = await rig.post({ ...rig.body, message: 'Show W-1 and the widget W-2' });
    expect(answer.json()).toMatchObject({ status: 'answered', route: 'ask' });
    expect(entityReads(rig) - before).toBe(2);
    expect(everything(rig).filter((event) => event.action === 'assistant.turn.closed')).toMatchObject([{ detail: { turn: { steps: 2 } } }]);
    await rig.stop();
  });

  it('answers over what was read when the steps of the turn are spent, and reads nothing more', async () => {
    const rig = await assistantRig({ maxSteps: 2, reply: sequence(ROUTE, '{"tool":"widgetById","values":{"id":"W-2"}}', '{"tool":"widgetById","values":{"id":"W-3"}}', '{"done":true}', ANSWER), answer: (call) => (call.templateId === 'entity-load' ? { status: 'rows', rows: [{ n: widgetNode('W-2') }] } : undefined) });
    const before = entityReads(rig);
    const answer = await rig.post({ ...rig.body, message: 'Show many' });
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ status: 'answered', route: 'ask', steps: 2, calls: 5, stoppedAt: 'steps', reads: [{ tool: 'widgetById', kind: 'intent', read: true }, { tool: 'widgetById', kind: 'intent', subject: 'W-2', read: true }] });
    expect(entityReads(rig) - before).toBe(2);
    expect(everything(rig).filter((event) => event.action === 'assistant.turn.closed')).toMatchObject([{ detail: { turn: { outcome: 'answered', steps: 2, modelCalls: 5, cause: 'limit-steps' } } }]);
    await rig.stop();
  });
});

describe('the ask route through the real gate', () => {
  it('runs the intent once through the gate as the caller and answers the agent’s cited sentence over its result, with one event and no value in it', async () => {
    const rig = await assistantRig({ reply: sequenceOf('{"route":"ask","intent":"widgetById","entities":{"id":"W-1"}}', DONE, JSON.stringify({ sentences: [{ text: 'Widget W-1 is listed.', cites: ['r1'] }] })) });
    const before = rig.rig.executor.calls.filter((call) => call.templateId === 'entity-load').length;
    const answer = await rig.post({ ...rig.body, message: 'Show widget W-1' });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({ status: 'answered', route: 'ask', sentences: [{ text: 'Widget W-1 is listed.', cites: ['r1'] }], reads: [{ tool: 'widgetById', kind: 'intent', read: true }] });
    expect(rig.rig.executor.calls.filter((call) => call.templateId === 'entity-load')).toHaveLength(before + 1);
    const events = rig.rig.events.filter((event) => event.action === 'assistant.ask');
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(/W-1|Show widget/);
    await rig.stop();
  });

  it('answers that there is no widget with an id the source does not hold, after the lookup of the id and before any read of the intent', async () => {
    const rig = await assistantRig({ reply: '{"route":"ask","intent":"widgetById","entities":{"id":"W-404"}}' });
    const before = rig.rig.executor.calls.length;
    const answer = await rig.post({ ...rig.body, message: 'Show widget W-404' });
    expect(answer.json()).toMatchObject({ status: 'answered', route: 'ask', answer: { refused: { cause: 'value-not-fit', valueNotFit: { kind: 'not-found', needed: 'widget' } } } });
    const reads = rig.rig.executor.calls.slice(before).filter((call) => !call.templateId.startsWith('schema-'));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((call) => call.templateId === 'entity-load-many')).toBe(true);
    await rig.stop();
  });

  it('hands a router reply that is not a route to the agent, runs nothing on the source and answers not-answered when the agent writes the same text', async () => {
    const rig = await assistantRig({ reply: 'MATCH (n) DETACH DELETE n' });
    const before = rig.rig.executor.calls.length;
    const answer = await rig.post();
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ status: 'not-answered', route: 'view' });
    expect(rig.rig.executor.calls).toHaveLength(before);
    await rig.stop();
  });
});

describe('the ask route and hostile values the router names', () => {
  it('never puts a value of the router into a statement text, whatever it holds, and answers 200 or a refusal of the product', async () => {
    const hostile = { value: 'W-1' };
    const rig = await assistantRig({ reply: () => JSON.stringify({ route: 'ask', intent: 'widgetById', entities: { id: hostile.value } }) });
    const first = rig.rig.executor.calls.length;
    await rig.post({ ...rig.body, message: 'Show a widget' });
    // the fixed words of the statements: a value that is one of them (such as `name`) is not a value that leaked
    const fixed = rig.rig.executor.calls.slice(first).map((call) => call.cypher).join('\n');
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.string({ maxLength: 120 }), fc.constantFrom("W-1' OR 1=1 //", '}) DETACH DELETE n //', '$id', '`; CALL dbms.shutdown()', 'W-1\u0000')), async (value) => {
        hostile.value = value;
        const before = rig.rig.executor.calls.length;
        const answer = await rig.post({ ...rig.body, message: 'Show a widget' });
        expect([200, 400]).toContain(answer.statusCode);
        if (answer.statusCode === 200) assistantTurnAnswerSchema.parse(answer.json());
        const text = rig.rig.executor.calls.slice(before).map((call) => call.cypher).join('\n');
        if (value.length >= 4 && !fixed.includes(value)) expect(text).not.toContain(value);
      }),
      // each turn's reads count against the person's rate of 120 requests a minute, so the runs stay under it
      { numRuns: 50 },
    );
    await rig.stop();
  });
});

describe('a file query through the real gate in the running application', () => {
  const REPLY = '{"route":"ask","intent":"queryById","entities":{"id":"W-1"}}';

  it('runs the stored query once, read-only, with the value as its only parameter, and answers over its rows with a step and a coverage line', async () => {
    const rig = await assistantRig({ reply: sequenceOf(REPLY, DONE, JSON.stringify({ sentences: [{ text: 'Widget W-1 is listed.', cites: ['r1'] }] })), fileQuery: { status: 'rows', rows: [{ n: widgetNode('W-1') }, { n: widgetNode('W-2') }] } });
    const before = rig.rig.executor.calls.length;
    const answer = await rig.post({ ...rig.body, message: 'Query widget W-1' });
    expect(answer.json()).toMatchObject({ status: 'answered', route: 'ask', sentences: [{ cites: ['r1'] }], coverage: expect.anything(), reads: [{ tool: 'queryById', kind: 'intent', read: true, rows: 2, quality: 'exact', partial: false }] });
    const calls = rig.rig.executor.calls.slice(before).filter((call) => call.templateId === 'file-query');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ accessMode: 'READ', parameters: { id: 'W-1' } });
    expect(Object.keys(calls[0]?.parameters ?? {})).toEqual(['id']);
    await rig.stop();
  });

  it('tells the agent that the query found nothing, and keeps a sentence that says so by citing the line of the read', async () => {
    const rig = await assistantRig({ reply: sequenceOf(REPLY, DONE, JSON.stringify({ sentences: [{ text: 'The query found no widget.', cites: ['s1'] }] })), fileQuery: { status: 'rows', rows: [] } });
    const answer = await rig.post({ ...rig.body, message: 'Query widget W-1' });
    expect(rig.stub.bodies[2]).toContain('Nothing was found.');
    expect(answer.json()).toMatchObject({ status: 'answered', route: 'ask', sentences: [{ text: 'The query found no widget.' }], reads: [{ tool: 'queryById', kind: 'intent' }] });
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

describe('a heavy step of the loop through the real gate in the running application', () => {
  const ROUTE = '{"route":"ask","intent":"widgetById","entities":{"id":"W-1"}}';
  const ANSWER = JSON.stringify({ sentences: [{ text: 'Ana Silva is listed.', cites: ['r1'] }, { text: 'Ana Silva is linked to GT-1.', cites: ['r5'] }] });
  const widget = (id: string) => plainNode(['Widget'], { widgetId: id, ownerName: 'Ana Silva' }, `4:s:${id}`);
  const gadget = plainNode(['Gadget'], { gadgetId: 'GT-1' }, '4:s:GT-1');
  const sequence = (...replies: string[]) => {
    let next = 0;
    return () => replies[Math.min(next++, replies.length - 1)] ?? '{"done":true}';
  };
  const source = (call: ExecuteCall): ExecuteOutcome | undefined => {
    if (call.templateId === 'entity-load') return { status: 'rows', rows: [{ n: widgetNode('W-1') }] };
    if (call.templateId === 'shared-attribute-count') return { status: 'rows', rows: [{ matches: 1_000_000, anchorBounded: false, skipped: false }] };
    if (call.templateId !== 'shared-attribute') return undefined;
    const row = (match: string) => ({ a: widget('W-1'), b: widget(match), xs: [gadget], ras: [plainRelationship('MADE_FROM', widget('W-1'), gadget, { linkId: 'L-1' }, '5:s:L-1')], rbs: [plainRelationship('MADE_FROM', widget(match), gadget, { linkId: `L-${match}` }, `5:s:L-${match}`)] });
    return { status: 'rows', rows: [row('W-2'), row('W-3')] };
  };
  const everything = (rig: Awaited<ReturnType<typeof assistantRig>>): AuditEvent[] => [...rig.events, ...rig.rig.events];
  const pages = (rig: Awaited<ReturnType<typeof assistantRig>>) => rig.rig.executor.calls.filter((call) => call.templateId === 'shared-attribute').length;
  const MESSAGE = 'Show W-1 and the widgets that share a gadget with it';

  it('waits for the analyst, reads no page before the decision, reads one after Confirm, and refuses the same plan again, with every step of it audited', async () => {
    const rig = await assistantRig({ threadStore: createMemoryAssistantThreadStore(), maxSteps: 4, reply: sequence(ROUTE, '{"tool":"sharedGadget","values":{"id":"W-1"}}', '{"done":true}', ANSWER), answer: source });
    const waiting = assistantTurnAnswerSchema.parse((await rig.post({ ...rig.body, message: MESSAGE })).json());
    if (waiting.status !== 'confirmation') throw new Error(`not waiting: ${JSON.stringify(waiting).slice(0, 200)}`);
    expect(waiting).toMatchObject({ step: { tool: 'sharedGadget', kind: 'intent', subject: 'W-1', count: { quality: 'lowerBound' } }, reads: [{ tool: 'widgetById' }] });
    expect(JSON.stringify(waiting)).not.toMatch(/continueToken|Ana Silva/);
    expect(pages(rig)).toBe(0);
    const decision = { ...rig.body, message: MESSAGE, confirmation: { pendingId: waiting.pendingId, plan: waiting.plan, decision: 'confirm' } };
    const answer = assistantTurnAnswerSchema.parse((await rig.post(decision)).json());
    expect(answer).toMatchObject({ status: 'answered', route: 'ask', steps: 2, reads: [{ tool: 'widgetById' }, { tool: 'sharedGadget' }] });
    expect(pages(rig)).toBe(1);
    // the elements the answer cites are named by the titles the reads gave, drawn or not: the entity and the relationship
    if (!('citations' in answer)) throw new Error('not a steps answer');
    expect(answer.citations).toMatchObject([{ key: 'r1', kind: 'entity', title: 'Ana Silva' }, { key: 'r5', kind: 'relationship', title: expect.stringContaining('Ana Silva → GT-1') }]);
    expect(assistantTurnAnswerSchema.parse((await rig.post(decision)).json())).toMatchObject({ status: 'confirmation-invalid' });
    expect(pages(rig)).toBe(1);
    const events = everything(rig);
    expect(events.filter((event) => event.action === 'assistant.confirmation').map((event) => (event.detail as { turn: { cause: string } }).turn.cause)).toEqual(['shown', 'confirm', 'invalid-used']);
    expect(events.filter((event) => event.action === 'assistant.turn.closed').map((event) => (event.detail as { turn: { outcome: string } }).turn.outcome)).toEqual(['confirmation', 'answered', 'refused']);
    expect(JSON.stringify(events)).not.toMatch(/Ana Silva|W-1/);
    await rig.stop();
  });

  it('reads nothing of the step after Skip, and answers over what was read', async () => {
    const rig = await assistantRig({ threadStore: createMemoryAssistantThreadStore(), maxSteps: 4, reply: sequence(ROUTE, '{"tool":"sharedGadget","values":{"id":"W-1"}}', '{"done":true}', ANSWER), answer: source });
    const waiting = assistantTurnAnswerSchema.parse((await rig.post({ ...rig.body, message: MESSAGE })).json());
    if (waiting.status !== 'confirmation') throw new Error('not waiting');
    const answer = assistantTurnAnswerSchema.parse((await rig.post({ ...rig.body, message: MESSAGE, confirmation: { pendingId: waiting.pendingId, plan: waiting.plan, decision: 'skip' } })).json());
    expect(answer).toMatchObject({ status: 'answered', route: 'ask' });
    expect(pages(rig)).toBe(0);
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
    expect(continued).toMatchObject({ reads: [expect.objectContaining({ tool: 'sharedGadget', kind: 'intent', read: true })], coverage: expect.stringContaining('matches shown') });
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

  it('answers the view route from the elements in view: the router call and two audited agent calls, the source read through the gate, and the values only in what the provider received after the read', async () => {
    const replies = ['{"route":"view"}', '{"tool":"view","values":{}}', DONE, JSON.stringify({ sentences: [{ text: 'Widget W-1 is owned by Ana Silva.', cites: ['n1'] }] })];
    const rig = await assistantRig({ reply: () => replies.shift() ?? '' });
    const before = rig.rig.executor.calls.length;
    const keys = ['W-1', 'W-2'].map((id) => JSON.stringify(['node', 'demo', 'widget', id]));
    const answer = await rig.post({ ...rig.body, message: 'Who owns the first one?', viewElementKeys: keys });
    expect(answer.statusCode).toBe(200);
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ status: 'answered', route: 'view', calls: 3, citations: [{ key: 'n1', kind: 'entity' }] });
    expect(rig.rig.executor.calls.length).toBeGreaterThan(before);
    expect(rig.stub.bodies).toHaveLength(3);
    expect(rig.stub.bodies[0]).not.toContain('Ana Silva');
    expect(rig.stub.bodies[1]).not.toContain('Ana Silva');
    expect(rig.stub.bodies[2]).toContain('Ana Silva');
    expect(rig.events.filter((event) => event.action === 'assistant.agent')).toHaveLength(2);
    expect(JSON.stringify(rig.events)).not.toContain('Ana Silva');
    await rig.stop();
  });

  it('reads a stored relationship key with its ends and cites it, and refuses a key of another source before any model call', async () => {
    const replies = ['{"route":"view"}', '{"tool":"view","values":{}}', DONE, JSON.stringify({ sentences: [{ text: 'The widget W-1 is linked to a gadget.', cites: ['n1', 'e1'] }] })];
    const rig = await assistantRig({ reply: () => replies.shift() ?? '' });
    const widgetKey = JSON.stringify(['node', 'demo', 'widget', 'W-1']);
    const linkKey = JSON.stringify(['edge', 'demo', 'stored', 'MADE_FROM', 'widget', 'gadget', 'L-1']);
    const answer = await rig.post({ ...rig.body, message: 'What is W-1 linked to?', viewElementKeys: [widgetKey, linkKey] });
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ status: 'answered', route: 'view', citations: expect.arrayContaining([expect.objectContaining({ key: 'e1', kind: 'relationship' })]) });
    const before = rig.stub.bodies.length;
    const foreign = await rig.post({ ...rig.body, message: 'What is W-1 linked to?', viewElementKeys: [JSON.stringify(['node', 'other', 'widget', 'W-1'])] });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(JSON.stringify(foreign.json())).not.toContain('other');
    expect(rig.stub.bodies).toHaveLength(before);
    await rig.stop();
  });

  it('leaves an element the person may not export out of what the provider receives, and refuses a viewer before any read or answer call', async () => {
    const replies = ['{"route":"view"}', '{"tool":"view","values":{}}', DONE, JSON.stringify({ sentences: [{ text: 'Widget W-1 is in view.', cites: ['n1'] }] })];
    const rig = await assistantRig({ reply: () => replies.shift() ?? '', unexportableNode: 'W-2' });
    const keys = ['W-1', 'W-2'].map((id) => JSON.stringify(['node', 'demo', 'widget', id]));
    const answer = await rig.post({ ...rig.body, message: 'What is in view?', viewElementKeys: keys });
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ status: 'answered', route: 'view' });
    expect(rig.stub.bodies[2]).toContain('W-1');
    for (const body of rig.stub.bodies.slice(1)) expect(body).not.toContain('W-2');
    await rig.stop();
    const viewerReplies = ['{"route":"view"}'];
    const viewer = await assistantRig({ reply: () => viewerReplies.shift() ?? '', principal: () => ({ role: 'viewer' }) });
    const before = viewer.rig.executor.calls.length;
    const denied = await viewer.post({ ...viewer.body, message: 'What is in view?', viewElementKeys: keys });
    expect(denied.statusCode).toBe(403);
    expect(viewer.rig.executor.calls).toHaveLength(before);
    expect(viewer.stub.bodies).toHaveLength(1);
    await viewer.stop();
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

describe('the closing event of a turn in the running application', () => {
  const CANARY = 'CANARY-MESSAGE-7';
  const REPLY_CANARY = 'REPLY-CANARY';
  const closed = (events: AuditEvent[]) => events.filter((event) => event.action === 'assistant.turn.closed');
  type Rig = Awaited<ReturnType<typeof assistantRig>>;
  const everything = (rig: Rig): AuditEvent[] => [...rig.events, ...rig.rig.events];
  const routerPrompt = readFileSync(new URL('../../../../ee/ask/prompts/assistant-router.md', import.meta.url), 'utf8').split('\n').find((line) => line.startsWith('You help')) ?? '';
  const timedOut = (call: ExecuteCall): ExecuteOutcome | undefined => (call.templateId === 'entity-load' ? { status: 'timeout' } : undefined);

  const outcomes: { name: string; reply: string; then?: readonly string[]; options?: Partial<Parameters<typeof assistantRig>[0]>; body?: (rig: Rig) => object; closing: Record<string, unknown> }[] = [
    { name: 'answered', reply: '{"route":"ask","intent":"widgetById","entities":{"id":"W-1"}}', then: [DONE, ANSWER_OF_W1], closing: { route: 'ask', outcome: 'answered', intent: 'widgetById', templateId: 'entity', steps: 1, modelCalls: 3 } },
    { name: 'refused', reply: '{"route":"refuse","cause":"verdict"}', closing: { route: 'refuse', outcome: 'refused', cause: 'verdict', modelCalls: 1 } },
    { name: 'unplaced', reply: `${REPLY_CANARY} is no route`, closing: { route: 'view', outcome: 'refused', cause: 'not-answered', modelCalls: 3 } },
    { name: 'view', reply: '{"route":"view"}', closing: { route: 'view', outcome: 'refused', cause: 'not-answered', modelCalls: 2 } },
    { name: 'too-long', reply: '{"route":"view"}', body: (rig) => ({ ...rig.body, message: Array.from({ length: 1001 }, () => CANARY).join(' ') }), closing: { outcome: 'refused', cause: 'too-long', modelCalls: 0 } },
    { name: 'continue-invalid', reply: '{"route":"view"}', body: (rig) => ({ sourceId: 'demo', investigationId: rig.body.investigationId, viewElementKeys: [CANARY_KEY], continue: { intent: 'widgetById', entities: { id: 'W-1' }, continueToken: `${'1'.repeat(13)}.${'a'.repeat(64)}` } }), closing: { outcome: 'refused', cause: 'continue-invalid', modelCalls: 0 } },
    { name: 'failed', reply: '{"route":"ask","intent":"widgetById","entities":{"id":"W-1"}}', options: { answer: timedOut }, closing: { route: 'ask', outcome: 'failed', intent: 'widgetById', steps: 1, modelCalls: 2 } },
  ];

  async function turn(item: (typeof outcomes)[number], rigOptions: Partial<Parameters<typeof assistantRig>[0]> = {}) {
    const rig = await assistantRig({ reply: item.then === undefined ? item.reply : sequenceOf(item.reply, ...item.then), ...item.options, ...rigOptions });
    const body = item.body?.(rig) ?? { ...rig.body, message: `Show ${CANARY} W-1`, viewElementKeys: [CANARY_KEY] };
    const answer = await rig.post(body);
    return { rig, answer };
  }

  it.each(outcomes)('is written once for the $name turn, with the fields of its end and no canary of the message, a value, the instructions, a reply or the answer', async (item) => {
    const { rig, answer } = await turn(item);
    expect(answer.statusCode).toBe(200);
    await vi.waitFor(() => expect(closed(everything(rig))).toHaveLength(1));
    const [event] = closed(everything(rig));
    expect(event).toMatchObject({ sourceId: 'demo', investigationId: rig.body.investigationId, detail: { turn: item.closing } });
    const text = JSON.stringify(everything(rig));
    for (const canary of [CANARY, 'W-1', 'key-canary-9', REPLY_CANARY, 'Choose the intent that answers the question', routerPrompt, 'Ana Silva']) expect(text, canary).not.toContain(canary);
    for (const sentence of JSON.stringify(answer.json()).match(/"text":"([^"]+)"/g) ?? []) expect(text).not.toContain(sentence.slice(8, -1));
    if (item.name === 'answered') {
      expect(event).toMatchObject({ result: 'success', detail: { turn: { modelRef: 'claude-sonnet-5-5', promptId: 'assistant.agent', tokensIn: 10, tokensOut: 5 } } });
      expect(JSON.stringify(answer.json())).toContain('Ana Silva');
    }
    await rig.stop();
  });

  const recordsFor = () => {
    const queue = createEventQueue<RecordJob>({ sinks: [{ name: 'run-records', sink: { record: (job) => job.write() } }], idFields: (job) => job.ids, settings: { queueSize: 100, retryLimit: 0, retryWaitMs: 10, writeTimeoutMs: 1000 }, logger: { warn: () => undefined } });
    return { queue, attached: { enqueue: (job: RecordJob) => void queue.sink.record(job) } satisfies RecordQueue };
  };
  const LEAK_CANARIES = [CANARY, 'W-1', 'key-canary-9', REPLY_CANARY, 'Choose the intent that answers the question', routerPrompt, 'Ana Silva'];
  const leaks = (text: string, label: string): void => {
    for (const canary of LEAK_CANARIES) expect(text, `${label}: ${canary}`).not.toContain(canary);
  };

  /** A turn the client gives up while its model call (`model`) or its read (`read`) is pending, ended by an abort of the real connection. */
  async function cancelledTurn(kind: 'model' | 'read', rigOptions: Partial<Parameters<typeof assistantRig>[0]> = {}) {
    const reads = { pending: 0 };
    const rig = await assistantRig({
      reply: kind === 'model' ? '{"route":"view"}' : '{"route":"ask","intent":"widgetById","entities":{"id":"W-1"}}',
      ...(kind === 'model' ? { hang: true } : { answer: (call: ExecuteCall) => (call.templateId === 'entity-load' ? new Promise<ExecuteOutcome>((resolve) => { reads.pending += 1; call.signal?.addEventListener('abort', () => resolve({ status: 'cancelled' })); }) : undefined) }),
      ...rigOptions,
    });
    const address = await rig.rig.app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const sent = fetch(`${address}/v1/assistant/turns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...rig.body, message: `Show ${CANARY} W-1`, viewElementKeys: [CANARY_KEY] }), signal: controller.signal }).catch(() => undefined);
    await vi.waitFor(() => expect(kind === 'model' ? rig.stub.bodies.length : reads.pending).toBeGreaterThan(0));
    controller.abort();
    await sent;
    return rig;
  }

  it.each([
    ['model', { route: undefined, intent: undefined, steps: 0, modelCalls: 1, promptId: 'assistant.route' }],
    ['read', { route: 'ask', intent: 'widgetById', steps: 1, modelCalls: 2, promptId: 'assistant.agent' }],
  ] as const)('is written once, as cancelled, when the client gives up a turn whose %s is pending, with no canary', async (kind, fields) => {
    const rig = await cancelledTurn(kind);
    await vi.waitFor(() => expect(closed(everything(rig))).toHaveLength(1));
    const [event] = closed(everything(rig));
    expect(event).toMatchObject({ result: 'failed', detail: { turn: { outcome: 'cancelled', ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) } } });
    leaks(JSON.stringify(everything(rig)), kind);
    await rig.stop();
  });

  it.each([
    ['model', 'cancelled', 'cancelled', 1],
    ['read', 'answered', 'cancelled', 2],
  ] as const)('stores the run of a turn the client gives up while its %s is pending: the call is %s and the run %s, through the real HTTP abort', async (kind, callStatus, runOutcome, calls) => {
    const store = createMemoryAssistantRunStore();
    const records = recordsFor();
    const rig = await cancelledTurn(kind, { runStore: store, recordQueue: records.attached });
    await vi.waitFor(() => expect(store.runs[0]?.outcome).toBeDefined());
    expect(store.runs[0]).toMatchObject({ outcome: runOutcome, calls });
    expect(store.runs[0]?.callEnds[0]).toMatchObject({ status: callStatus });
    expect(store.runs[0]?.callStarts[0]?.valuesText).toContain(CANARY);
    leaks(JSON.stringify([...everything(rig)]), kind);
    await rig.stop();
  });

  const SHARED_REPLY = '{"route":"ask","intent":"sharedGadget","entities":{"id":"W-1"}}';
  const heavyThenHang = (reads: { pending: number }) => (call: ExecuteCall): ExecuteOutcome | Promise<ExecuteOutcome> | undefined => {
    if (call.templateId === 'shared-attribute-count') return { status: 'rows', rows: [{ matches: 1_000_000, anchorBounded: false, skipped: false }] };
    if (call.templateId !== 'shared-attribute') return undefined;
    return new Promise<ExecuteOutcome>((resolve) => {
      reads.pending += 1;
      call.signal?.addEventListener('abort', () => resolve({ status: 'cancelled' }));
    });
  };

  it('ends a confirmed heavy read that is pending as one cancelled turn, with its run stored cancelled, when the client closes the real connection, and reads nothing more', async () => {
    const reads = { pending: 0 };
    const store = createMemoryAssistantRunStore();
    const records = recordsFor();
    const rig = await assistantRig({ maxSteps: 4, reply: SHARED_REPLY, answer: heavyThenHang(reads), runStore: store, recordQueue: records.attached });
    const message = 'Which widgets share a gadget with W-1?';
    const waiting = assistantTurnAnswerSchema.parse((await rig.post({ ...rig.body, message })).json());
    if (waiting.status !== 'confirmation') throw new Error('not waiting');
    const address = await rig.rig.app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const sent = fetch(`${address}/v1/assistant/turns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...rig.body, message, confirmation: { pendingId: waiting.pendingId, plan: waiting.plan, decision: 'confirm' } }), signal: controller.signal }).catch(() => undefined);
    await vi.waitFor(() => expect(reads.pending).toBe(1));
    controller.abort();
    await sent;
    await vi.waitFor(() => expect(closed(everything(rig))).toHaveLength(2));
    expect(closed(everything(rig))[1]).toMatchObject({ result: 'failed', detail: { turn: { outcome: 'cancelled', modelCalls: 0, steps: 1 } } });
    expect(reads.pending).toBe(1);
    await vi.waitFor(() => expect(store.runs).toHaveLength(2));
    await vi.waitFor(() => expect(store.runs[1]?.outcome).toBeDefined());
    expect(store.runs[1]).toMatchObject({ outcome: 'cancelled', calls: 0 });
    await rig.stop();
  });

  it('changes nothing when the client closes the real connection after the answer was returned: one model call and one closing event, as the answer left it', async () => {
    const rig = await assistantRig();
    const address = await rig.rig.app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const answered = await fetch(`${address}/v1/assistant/turns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rig.body), signal: controller.signal });
    await answered.json();
    controller.abort();
    await vi.waitFor(() => expect(closed(everything(rig))).toHaveLength(1));
    expect(closed(everything(rig))[0]).toMatchObject({ result: 'refused', detail: { turn: { outcome: 'refused', modelCalls: 1 } } });
    expect(rig.stub.bodies).toHaveLength(1);
    await rig.stop();
  });

  const stores = [
    ['a store that rejects every write', () => ({ record: () => Promise.reject(new Error('the store is down')) }), 100],
    ['a store that never answers, under a queue of one place', () => ({ record: () => new Promise<void>(() => undefined) }), 1],
  ] as const;

  const queueOver = (makeStore: () => AuditSink, size: number) => {
    const logs: Record<string, unknown>[] = [];
    const queue = createAuditQueue({ sinks: [{ name: 'test', sink: makeStore() }], settings: { queueSize: size, retryLimit: 0, retryWaitMs: 10, writeTimeoutMs: 1000 }, logger: { warn: (fields) => void logs.push(fields) } });
    return { queue, logs };
  };

  const diagnosed = (logs: Record<string, unknown>[], label: string): void => {
    expect(logs.some((line) => line['action'] === 'assistant.turn.closed' && (line['event'] === 'audit.event_failed' || line['event'] === 'audit.event_dropped')), label).toBe(true);
    leaks(JSON.stringify(logs), label);
    for (const line of logs) expect(Object.keys(line).every((key) => ['event', 'sink', 'action', 'result', 'traceId', 'actorId', 'sourceId', 'investigationId'].includes(key)), label).toBe(true);
  };

  it.each(stores)('gives the same answer for each outcome through the queue of the application over %s, and counts and logs the closing event that fails or is dropped, ids only', async (_name, makeStore, size) => {
    for (const item of outcomes) {
      const baseline = await turn(item);
      const { queue, logs } = queueOver(makeStore, size);
      const { rig, answer } = await turn(item, { requestAudit: queue.sink, modelAudit: queue.sink });
      expect(answer.statusCode, item.name).toBe(baseline.answer.statusCode);
      expect(sameButTokens(answer.json()), item.name).toEqual(sameButTokens(baseline.answer.json()));
      await vi.waitFor(() => expect(logs.some((line) => line['action'] === 'assistant.turn.closed'), item.name).toBe(true));
      expect(queue.counts().failed + queue.counts().dropped, item.name).toBeGreaterThan(0);
      diagnosed(logs, item.name);
      await rig.stop();
      await baseline.rig.stop();
    }
  });

  it.each(stores)('ends a cancelled turn, model call or read, the same way through the queue over %s, and counts and logs its closing event, ids only', async (_name, makeStore, size) => {
    for (const kind of ['model', 'read'] as const) {
      const baseline = await cancelledTurn(kind);
      await vi.waitFor(() => expect(closed(everything(baseline))).toHaveLength(1));
      const { queue, logs } = queueOver(makeStore, size);
      const rig = await cancelledTurn(kind, { requestAudit: queue.sink, modelAudit: queue.sink });
      await vi.waitFor(() => expect(logs.some((line) => line['action'] === 'assistant.turn.closed'), kind).toBe(true));
      expect(queue.counts().failed + queue.counts().dropped, kind).toBeGreaterThan(0);
      diagnosed(logs, kind);
      expect(closed(everything(rig))).toHaveLength(0);
      await rig.stop();
      await baseline.stop();
    }
  });
});

describe('a view answer when the audit store fails or does not answer', () => {
  const widgets = ['W-1', 'W-2'].map((id) => JSON.stringify(['node', 'demo', 'widget', id]));
  const viewReplies = () => {
    const replies = ['{"route":"view"}', '{"tool":"view","values":{}}', DONE, JSON.stringify({ sentences: [{ text: 'Widget W-1 is in view.', cites: ['n1'] }] })];
    return () => replies.shift() ?? '';
  };
  const queueOver = (store: AuditSink, size = 100) => createAuditQueue({ sinks: [{ name: 'test', sink: store }], settings: { queueSize: size, retryLimit: 0, retryWaitMs: 10, writeTimeoutMs: 1000 }, logger: { warn: () => undefined } });

  it('answers the same, at once, when the store fails every write, and counts the failures', async () => {
    const down = queueOver({ record: () => Promise.reject(new Error('the store is down')) });
    const rig = await assistantRig({ modelAudit: down.sink, reply: viewReplies() });
    const answer = await rig.post({ ...rig.body, message: 'What is in view?', viewElementKeys: widgets });
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ status: 'answered', route: 'view' });
    await vi.waitFor(() => expect(down.counts().failed).toBeGreaterThan(0));
    await rig.stop();
  });

  it('answers the same when the store never answers and the queue is full, and counts what was dropped, with text-free logs', async () => {
    const logs: Record<string, unknown>[] = [];
    const blocked = createAuditQueue({ sinks: [{ name: 'test', sink: { record: () => new Promise<void>(() => undefined) } }], settings: { queueSize: 1, retryLimit: 0, retryWaitMs: 10, writeTimeoutMs: 1000 }, logger: { warn: (fields) => void logs.push(fields) } });
    const rig = await assistantRig({ modelAudit: blocked.sink, reply: viewReplies() });
    const answers = [];
    for (let turn = 0; turn < 3; turn += 1) answers.push(await rig.post({ ...rig.body, message: 'What is in view SENTINEL-VIEW-TEXT?', viewElementKeys: widgets }));
    expect(answers.map((answer) => answer.statusCode)).toEqual([200, 200, 200]);
    expect(assistantTurnAnswerSchema.parse(answers[0]?.json())).toMatchObject({ status: 'answered', route: 'view' });
    expect(blocked.counts().dropped).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain('SENTINEL-VIEW-TEXT');
    await rig.stop();
  });

  it('reads aggregate and derived relationship keys through the gate, which counts the two it cannot resolve in the coverage line', async () => {
    const rig = await assistantRig({ reply: viewReplies() });
    const widget = (id: string) => JSON.stringify(['node', 'demo', 'widget', id]);
    const keys = [widget('W-1'), JSON.stringify(['edge', 'demo', 'aggregate', 'MADE_FROM', widget('W-1'), widget('W-2')]), JSON.stringify(['edge', 'demo', 'derived', 'rule-1', widget('W-1'), widget('W-2')])];
    const answer = await rig.post({ ...rig.body, message: 'What is in view?', viewElementKeys: keys });
    expect(answer.statusCode).toBe(200);
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ coverage: { retrieval: expect.stringContaining('2 references could not be read') } });
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ status: 'answered', route: 'view' });
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

describe('the stored runs of a turn in the running application', () => {
  const CANARY = 'CANARY-MESSAGE-7';
  const REPLY_CANARY = 'REPLY-CANARY';
  const SETTINGS = { queueSize: 100, retryLimit: 0, retryWaitMs: 10, writeTimeoutMs: 1000 };
  const timedOut = (call: ExecuteCall): ExecuteOutcome | undefined => (call.templateId === 'entity-load' ? { status: 'timeout' } : undefined);
  const ASK = '{"route":"ask","intent":"widgetById","entities":{"id":"W-1"}}';

  const recordsOver = (write: (job: RecordJob) => Promise<void>, size = SETTINGS.queueSize) => {
    const logs: Record<string, unknown>[] = [];
    const queue = createEventQueue<RecordJob>({ sinks: [{ name: 'run-records', sink: { record: (job) => write(job) } }], idFields: (job) => job.ids, settings: { ...SETTINGS, queueSize: size }, logger: { warn: (fields) => void logs.push(fields) } });
    const attached: RecordQueue = { enqueue: (job) => void queue.sink.record(job) };
    return { queue, attached, logs, auditCounts: () => queue.counts() };
  };

  const outcomes = [
    { name: 'answered', reply: ASK, then: [DONE, ANSWER_OF_W1], words: 3, calls: 3 },
    { name: 'refused', reply: '{"route":"refuse","cause":"verdict"}', words: 3, calls: 1 },
    { name: 'unplaced', reply: `${REPLY_CANARY} is no route`, words: 3, calls: 3 },
    { name: 'failed', reply: ASK, options: { answer: timedOut }, words: 3, calls: 2 },
    { name: 'too-long', reply: '{"route":"view"}', words: 1001, calls: 0 },
  ] as const;

  async function turnWith(item: { reply: string; then?: readonly string[]; words?: number; options?: Partial<Parameters<typeof assistantRig>[0]> }, options: Partial<Parameters<typeof assistantRig>[0]> = {}) {
    const rig = await assistantRig({ reply: item.then === undefined ? item.reply : sequenceOf(item.reply, ...item.then), ...item.options, ...options });
    const message = item.words !== undefined && item.words > 100 ? Array.from({ length: item.words }, () => CANARY).join(' ') : `Show ${CANARY} W-1`;
    const answer = await rig.post({ ...rig.body, message, viewElementKeys: [CANARY_KEY] });
    return { rig, answer };
  }
  const readyz = async (rig: Awaited<ReturnType<typeof assistantRig>>) => (await rig.rig.app.inject({ method: 'GET', url: '/readyz' })).json();

  it.each(outcomes)('stores the instructions, the values and the reply of the $name turn, through the queue of the records, linked to its audit events by the run id', async (item) => {
    const store = createMemoryAssistantRunStore();
    const records = recordsOver((job) => job.write());
    const { rig, answer } = await turnWith(item, { runStore: store, recordQueue: records.attached });
    expect(answer.statusCode).toBe(200);
    await vi.waitFor(() => expect(store.runs[0]?.outcome).toBeDefined());
    const [recorded] = store.runs;
    expect(recorded).toMatchObject({ start: { sourceId: 'demo', traceId: expect.any(String), settings: { model: 'claude-sonnet-5-5' } } });
    if (item.name === 'too-long') {
      expect(recorded).toMatchObject({ calls: 0, outcome: 'refused' });
    } else {
      expect(recorded).toMatchObject({ calls: item.calls });
      expect(recorded?.callStarts[0]?.valuesText).toContain(CANARY);
      expect(recorded?.callStarts[0]?.valuesText).toContain('key-canary-9');
      expect(recorded?.callStarts[0]?.instructionsText).toContain('Choose the intent that answers the question');
      expect(recorded?.callEnds[0]).toMatchObject({ status: item.name === 'unplaced' ? 'failed' : 'answered', tokensIn: 10, tokensOut: 5, replyText: item.reply });
    }
    const all = [...rig.events, ...rig.rig.events];
    const linked = all.filter((event) => JSON.stringify(event.detail ?? null).includes(recorded?.id ?? 'none'));
    expect(linked.length).toBeGreaterThanOrEqual(1);
    expect(records.queue.counts()).toMatchObject({ failed: 0, dropped: 0 });
    await rig.stop();
  });

  it.each(outcomes)('keeps the stored text out of every audit event, log line, header, body, readiness output and error of the $name turn, and answers as a turn that records nothing', async (item) => {
    const store = createMemoryAssistantRunStore();
    const records = recordsOver((job) => job.write());
    const recording = await turnWith(item, { runStore: store, recordQueue: records.attached, auditCounts: records.auditCounts });
    const plain = await turnWith(item);
    expect(recording.answer.statusCode).toBe(plain.answer.statusCode);
    expect(sameButTokens(recording.answer.json())).toEqual(sameButTokens(plain.answer.json()));
    await vi.waitFor(() => expect(store.runs[0]?.outcome).toBeDefined());
    const ready = await recording.rig.rig.app.inject({ url: '/readyz' });
    const exposed = JSON.stringify({ events: [...recording.rig.events, ...recording.rig.rig.events], logs: records.logs, headers: recording.answer.headers, ready: ready.body });
    for (const canary of [CANARY, 'key-canary-9', REPLY_CANARY, 'Choose the intent that answers the question', 'You help an analyst']) expect(exposed, canary).not.toContain(canary);
    for (const canary of [CANARY, 'key-canary-9', REPLY_CANARY, 'Choose the intent that answers the question', 'You help an analyst']) expect(recording.answer.body, `body: ${canary}`).not.toContain(canary);
    if (item.name === 'answered') expect(recording.answer.body).toContain('W-1');
    else expect(recording.answer.body).not.toContain('W-1');
    await recording.rig.stop();
    await plain.rig.stop();
  });

  it('keeps the canaries of a refused request out of its error, the readiness output, the events and the logs, and stores nothing', async () => {
    const store = createMemoryAssistantRunStore();
    const records = recordsOver((job) => job.write());
    const rig = await assistantRig({ reply: ASK, runStore: store, recordQueue: records.attached, auditCounts: records.auditCounts });
    const refused = await rig.post({ ...rig.body, message: `Show ${CANARY}`, extra: REPLY_CANARY });
    expect(refused.statusCode).toBe(400);
    const ready = await readyz(rig);
    for (const canary of [CANARY, REPLY_CANARY]) {
      expect(refused.body, canary).not.toContain(canary);
      expect(JSON.stringify([ready, rig.events, rig.rig.events, records.logs]), canary).not.toContain(canary);
    }
    expect(store.runs).toEqual([]);
    await rig.stop();
  });

  it.each(outcomes)('answers the $name turn as before, counts every failed write in the health probe, writes the closing event, and logs run ids and steps only, when the store fails every write', async (item) => {
    const plain = await turnWith(item);
    let attempts = 0;
    const failing: AssistantRunStore = { ...createMemoryAssistantRunStore(), begin: () => (attempts++, Promise.reject(new Error('the store is down'))), beginCall: () => (attempts++, Promise.reject(new Error('the store is down'))), endCall: () => (attempts++, Promise.reject(new Error('the store is down'))), finish: () => (attempts++, Promise.reject(new Error('the store is down'))) };
    const records = recordsOver((job) => job.write());
    const recording = await turnWith(item, { runStore: failing, recordQueue: records.attached, auditCounts: records.auditCounts });
    expect(sameButTokens(recording.answer.json()), item.name).toEqual(sameButTokens(plain.answer.json()));
    await vi.waitFor(() => expect(records.queue.counts().failed, item.name).toBe(attempts));
    // the start and the end of the run, and the start and the end of each model call
    expect(attempts, item.name).toBe(2 + 2 * item.calls);
    expect((await readyz(recording.rig)).audit.failed, item.name).toBe(attempts);
    expect(records.logs.every((line) => line['event'] === 'audit.event_failed' && typeof line['runId'] === 'string' && typeof line['step'] === 'string'), item.name).toBe(true);
    expect(JSON.stringify(records.logs)).not.toContain(CANARY);
    expect([...recording.rig.events, ...recording.rig.rig.events].filter((event) => event.action === 'assistant.turn.closed'), item.name).toHaveLength(1);
    await recording.rig.stop();
    await plain.rig.stop();
  });

  it('does not wait for a store that never answers, and drops what the queue cannot hold, counted in the health probe and logged by ids', async () => {
    const never = new Promise<void>(() => undefined);
    const store: AssistantRunStore = { ...createMemoryAssistantRunStore(), begin: () => never, beginCall: () => never, endCall: () => never, finish: () => never };
    const records = recordsOver((job) => job.write(), 1);
    const { rig, answer } = await turnWith({ reply: '{"route":"refuse","cause":"verdict"}' }, { runStore: store, recordQueue: records.attached, auditCounts: records.auditCounts });
    expect(answer.statusCode).toBe(200);
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ status: 'answered', route: 'refuse' });
    await vi.waitFor(() => expect(records.queue.counts().dropped).toBeGreaterThan(0));
    expect((await readyz(rig)).audit.dropped).toBe(records.queue.counts().dropped);
    expect(JSON.stringify(records.logs)).not.toContain(CANARY);
    await rig.stop();
  });
});

/** What reached the source of a call: its query text and its parameters, never its trace identifier, which is a random identifier that can hold any short text, such as `c9`. */
const queryOf = (call: { readonly cypher?: unknown; readonly parameters?: unknown }): string => JSON.stringify({ cypher: call.cypher, parameters: call.parameters });

describe('what reached the source of a call, as the tests below read it', () => {
  it('leaves out the trace identifier, whatever random text it holds, and keeps the query and the parameters', () => {
    expect(queryOf({ cypher: 'RETURN 1', parameters: {}, traceId: 'tr-1b2c-a5c9-4924' } as never)).not.toMatch(/c9\b/);
    expect(queryOf({ cypher: 'RETURN 1', parameters: { id: 'c9' } })).toMatch(/c9\b/);
    expect(queryOf({ cypher: 'DETACH DELETE n', parameters: {} })).toMatch(/DETACH/);
  });
});

describe('the thread of an investigation in the running application', () => {
  const CANARY = 'CANARY-MESSAGE-7';
  const ASK = '{"route":"ask","intent":"widgetById","entities":{"id":"W-1"}}';
  const SETTINGS = { queueSize: 100, retryLimit: 0, retryWaitMs: 10, writeTimeoutMs: 1000 };
  const FIRST = '0192f000-0000-7000-8000-000000000001';
  const SECOND = '0192f000-0000-7000-8000-000000000002';
  let current = FIRST;

  const recordsOver = (size = SETTINGS.queueSize, write: (job: RecordJob) => Promise<void> = (job) => job.write()) => {
    const logs: Record<string, unknown>[] = [];
    const queue = createEventQueue<RecordJob>({ sinks: [{ name: 'run-records', sink: { record: (job) => write(job) } }], idFields: (job) => job.ids, settings: { ...SETTINGS, queueSize: size }, logger: { warn: (fields) => void logs.push(fields) } });
    return { queue, logs, attached: { enqueue: (job: RecordJob) => void queue.sink.record(job) } satisfies RecordQueue, auditCounts: () => queue.counts() };
  };
  type ThreadRig = Awaited<ReturnType<typeof assistantRig>>;
  const readThread = (rig: ThreadRig, id = rig.body.investigationId) => rig.rig.app.inject({ method: 'GET', url: `/v1/assistant/investigations/${id}/thread` });
  const send = (rig: ThreadRig, message = `Show ${CANARY} W-1`) => rig.post({ ...rig.body, message, viewElementKeys: [CANARY_KEY] });
  /** The replies of a first turn the agent answers over its read of W-1 (the router's, `{"done":true}` and the answer), then those of the next turn. */
  const answeredThen = (...next: string[]) => sequenceOf(ASK, DONE, ANSWER_OF_W1, ...next);
  /** The model calls of the answered first turn: the router's, the read, the answer and the agent's last reply. */
  const FIRST_TURN_CALLS = 3;

  it('keeps an answered turn and a refused turn, answers them back to their person as kinds and counts, and holds no text of the message, the value or the reply', async () => {
    current = FIRST;
    const threads = createMemoryAssistantThreadStore();
    const records = recordsOver();
    const rig = await assistantRig({ reply: answeredThen(), threadStore: threads, recordQueue: records.attached, principalId: () => current });
    expect((await send(rig)).statusCode).toBe(200);
    await vi.waitFor(() => expect(records.queue.counts().written).toBeGreaterThanOrEqual(1));
    const answer = await readThread(rig);
    expect(answer.statusCode).toBe(200);
    expect(assistantThreadResponseSchema.parse(answer.json())).toMatchObject({ turns: [{ seq: 1, route: 'ask', outcome: 'answered', intent: 'widgetById', citedElements: expect.any(Number), steps: 1 }], previousThreadClearedAt: null });
    for (const canary of [CANARY, 'key-canary-9', 'Ana Silva', 'Choose the intent that answers the question']) expect(answer.body, canary).not.toContain(canary);
    expect(answer.body).not.toMatch(/questionHash|runId|tokens|stableId|W-1/);
    const rows = JSON.stringify([...threads.threads.values()].flatMap((thread) => thread.turns));
    for (const canary of [CANARY, 'key-canary-9', 'Choose the intent that answers the question']) expect(rows, canary).not.toContain(canary);
    const logs = JSON.stringify([records.logs, rig.events, rig.rig.events]);
    expect(logs).not.toContain(CANARY);
    await rig.stop();
  });

  it('shows the router and the agent the earlier turn of the person with its element as a key, the thread keeping both turns', async () => {
    current = FIRST;
    const threads = createMemoryAssistantThreadStore();
    const records = recordsOver();
    const rig = await assistantRig({ reply: answeredThen('{"route":"ask","intent":"widgetById","entities":{},"elements":{"id":"c1"}}', DONE, ANSWER_OF_W1), threadStore: threads, recordQueue: records.attached, principalId: () => current });
    expect((await send(rig, 'Show W-1')).statusCode).toBe(200);
    await vi.waitFor(() => expect(records.queue.counts().written).toBeGreaterThanOrEqual(1));
    const second = await send(rig, 'and what else about it?');
    expect(second.statusCode).toBe(200);
    const router = JSON.stringify(rig.stub.bodies[FIRST_TURN_CALLS]);
    expect(router).toContain('Earlier turns of this thread, oldest first:');
    expect(router).toMatch(/c1 \| .* \| /);
    const agent = JSON.stringify(rig.stub.bodies[FIRST_TURN_CALLS + 1]);
    expect(agent).toContain('Earlier turns of this thread');
    expect(agent).toMatch(/c1 \| .* \| /);
    expect(JSON.stringify(rig.stub.bodies[0])).not.toContain('Earlier turns');
    await vi.waitFor(() => expect(records.queue.counts().written).toBeGreaterThanOrEqual(2));
    expect(assistantThreadResponseSchema.parse((await readThread(rig)).json())).toMatchObject({ turns: [{ route: 'ask', outcome: 'answered' }, { route: 'ask' }] });
    await rig.stop();
  });

  it('gives the agent the identifier of an earlier element the follow-up names, as a value for its tools', async () => {
    current = FIRST;
    const threads = createMemoryAssistantThreadStore();
    const records = recordsOver();
    const rig = await assistantRig({ reply: answeredThen('{"route":"ask","intent":"widgetById","entities":{},"elements":{"id":"c1"}}', DONE, ANSWER_OF_W1), threadStore: threads, recordQueue: records.attached, principalId: () => current });
    try {
      await send(rig, 'Show W-1');
      await vi.waitFor(() => expect(records.queue.counts().written).toBeGreaterThanOrEqual(1));
      const second = await send(rig, 'and what else about it?');
      expect(second.statusCode).toBe(200);
      expect(rig.stub.bodies.some((body) => body.includes('c1 = widget W-1'))).toBe(true);
    } finally {
      await rig.stop();
    }
  });

  it.each([
    ['a stable ID in the key position', 'W-1'],
    ['query text in the key position', 'c1); MATCH (n) DETACH DELETE n //'],
    ['a client key', JSON.stringify(['node', 'demo', 'widget', 'W-1'])],
  ])('lets %s reach the source in no form: the follow-up runs nothing and the gate sees only the read of the earlier turn’s elements', async (_name, key) => {
    current = FIRST;
    const threads = createMemoryAssistantThreadStore();
    const records = recordsOver();
    const rig = await assistantRig({ reply: answeredThen(JSON.stringify({ route: 'ask', intent: 'widgetById', entities: {}, elements: { id: key } })), threadStore: threads, recordQueue: records.attached, principalId: () => current });
    await send(rig, 'Show W-1');
    await vi.waitFor(() => expect(records.queue.counts().written).toBeGreaterThanOrEqual(1));
    const before = rig.rig.executor.calls.length;
    const second = assistantTurnAnswerSchema.parse((await send(rig, 'and what else about it?')).json());
    expect(second).toMatchObject({ status: 'not-answered', route: 'view' });
    const after = rig.rig.executor.calls.slice(before);
    expect(after.map((call) => call.templateId)).toEqual(['schema-indexes', 'entity-load-many']);
    for (const call of after) expect(queryOf(call)).not.toMatch(/DETACH|c9\b/);
    await rig.stop();
  });

  it('asks which element is meant for a key that names nothing, from the elements of the thread, and the gate sees only reads of elements, none of the intent', async () => {
    current = FIRST;
    const threads = createMemoryAssistantThreadStore();
    const records = recordsOver();
    const rig = await assistantRig({ reply: answeredThen('{"route":"ask","intent":"widgetById","entities":{},"elements":{"id":"c9"}}'), threadStore: threads, recordQueue: records.attached, principalId: () => current });
    await send(rig, 'Show W-1');
    await vi.waitFor(() => expect(records.queue.counts().written).toBeGreaterThanOrEqual(1));
    const before = rig.rig.executor.calls.length;
    const second = assistantTurnAnswerSchema.parse((await send(rig, 'and what else about it?')).json());
    expect(second).toMatchObject({ status: 'clarification', question: 'Which widget do you mean?' });
    expect(second.status === 'clarification' ? second.candidates.length : 0).toBeGreaterThan(0);
    expect(rig.rig.executor.calls.slice(before).every((call) => call.templateId === 'schema-indexes' || call.templateId === 'entity-load-many')).toBe(true);
    await vi.waitFor(() => expect(records.queue.counts().written).toBeGreaterThanOrEqual(1));
    expect(assistantThreadResponseSchema.parse((await readThread(rig)).json()).turns).toHaveLength(1);
    await rig.stop();
  });

  it('runs the choice of a clarification through the gate with no model call, keeps it in the thread and refuses the same choice sent by another person', async () => {
    current = FIRST;
    const threads = createMemoryAssistantThreadStore();
    const records = recordsOver();
    const rig = await assistantRig({ reply: answeredThen('{"route":"ask","intent":"widgetById","entities":{},"elements":{"id":"c9"}}'), threadStore: threads, recordQueue: records.attached, principalId: () => current });
    await send(rig, 'Show W-1');
    await vi.waitFor(() => expect(records.queue.counts().written).toBeGreaterThanOrEqual(1));
    const clarification = assistantTurnAnswerSchema.parse((await send(rig, 'and what else about it?')).json());
    if (clarification.status !== 'clarification') throw new Error('not a clarification');
    const choice = clarification.candidates[0]?.choice;
    const picked = await rig.post({ sourceId: 'demo', investigationId: rig.body.investigationId, viewElementKeys: [], choice });
    expect(picked.statusCode).toBe(200);
    expect(assistantTurnAnswerSchema.parse(picked.json())).toMatchObject({ status: 'answered', route: 'ask' });
    expect(rig.stub.bodies).toHaveLength(FIRST_TURN_CALLS + 1);
    await vi.waitFor(() => expect(records.queue.counts().written).toBeGreaterThanOrEqual(2));
    expect(assistantThreadResponseSchema.parse((await readThread(rig)).json()).turns).toHaveLength(2);
    current = SECOND;
    const stolen = await rig.post({ sourceId: 'demo', investigationId: rig.body.investigationId, viewElementKeys: [], choice });
    expect(stolen.statusCode).toBe(404);
    await rig.stop();
  });

  it('suggests another template question of the folder for the elements of the answer to a chosen clarification and runs the one pressed through the gate with no model call, once, for the person it was made for', async () => {
    current = FIRST;
    const threads = createMemoryAssistantThreadStore();
    const records = recordsOver();
    const rig = await assistantRig({ reply: answeredThen('{"route":"ask","intent":"widgetById","entities":{},"elements":{"id":"c9"}}'), threadStore: threads, recordQueue: records.attached, principalId: () => current });
    await send(rig, 'Show W-1');
    await vi.waitFor(() => expect(records.queue.counts().written).toBeGreaterThanOrEqual(1));
    const clarification = assistantTurnAnswerSchema.parse((await send(rig, 'and what else about it?')).json());
    if (clarification.status !== 'clarification') throw new Error('not a clarification');
    const answer = assistantTurnAnswerSchema.parse((await rig.post({ sourceId: 'demo', investigationId: rig.body.investigationId, viewElementKeys: [], choice: clarification.candidates[0]?.choice })).json());
    if (answer.status !== 'answered' || !('answer' in answer)) throw new Error('not an ask answer');
    const chip = answer.followUps?.[0];
    expect(answer.followUps?.map((held) => held.choice.intent)).toEqual(['sharedGadget']);
    expect(chip?.choice.roles).toEqual(['id']);
    const before = rig.rig.executor.calls.length;
    const pressed = await rig.post({ sourceId: 'demo', investigationId: rig.body.investigationId, viewElementKeys: [], choice: chip?.choice });
    expect(pressed.statusCode).toBe(200);
    expect(assistantTurnAnswerSchema.parse(pressed.json())).toMatchObject({ status: 'answered', route: 'ask' });
    expect(rig.stub.bodies).toHaveLength(FIRST_TURN_CALLS + 1);
    expect(rig.rig.executor.calls.length).toBeGreaterThan(before);
    await vi.waitFor(() => expect(records.queue.counts().written).toBeGreaterThanOrEqual(3));
    expect(assistantThreadResponseSchema.parse((await readThread(rig)).json()).turns).toHaveLength(3);
    current = SECOND;
    const stolen = await rig.post({ sourceId: 'demo', investigationId: rig.body.investigationId, viewElementKeys: [], choice: chip?.choice });
    expect(stolen.statusCode).toBe(404);
    await rig.stop();
  });

  it('answers a person only their own thread, NOT_FOUND for an investigation that is not theirs or does not exist, and the same for a thread of nobody', async () => {
    current = FIRST;
    const threads = createMemoryAssistantThreadStore();
    const records = recordsOver();
    const rig = await assistantRig({ reply: ASK, threadStore: threads, recordQueue: records.attached, principalId: () => current });
    await send(rig);
    await vi.waitFor(() => expect(records.queue.counts().written).toBeGreaterThanOrEqual(1));
    current = SECOND;
    const other = await readThread(rig);
    expect(other.statusCode).toBe(404);
    expect(other.json().error).toMatchObject({ code: 'NOT_FOUND' });
    expect((await readThread(rig, '01939999-0000-7000-8000-0000000000ff')).statusCode).toBe(404);
    current = FIRST;
    expect(assistantThreadResponseSchema.parse((await readThread(rig)).json()).turns).toHaveLength(1);
    await rig.stop();
  });

  it('says that the thread was cleared when the investigation was closed and reopened, and starts a new thread empty', async () => {
    current = FIRST;
    const threads = createMemoryAssistantThreadStore();
    const records = recordsOver();
    const rig = await assistantRig({ reply: ASK, threadStore: threads, recordQueue: records.attached, principalId: () => current });
    await send(rig);
    await vi.waitFor(() => expect(records.queue.counts().written).toBeGreaterThanOrEqual(1));
    threads.clear(rig.body.investigationId);
    threads.reopen(rig.body.investigationId);
    const read = assistantThreadResponseSchema.parse((await readThread(rig)).json());
    expect(read.turns).toEqual([]);
    expect(read.previousThreadClearedAt).toMatch(/^\d{4}-/);
    await rig.stop();
  });

  it('answers 403 with the reason ai-off when the assistant is off, and reads nothing', async () => {
    const rig = await assistantRig({ features: { ask: true, summary: false, assistant: false } });
    const answer = await readThread(rig);
    expect(answer.statusCode).toBe(403);
    expect(answer.json().error).toMatchObject({ code: 'ACCESS_DENIED', details: { reason: 'ai-off' } });
    await rig.stop();
  });

  it('answers INTERNAL_ERROR with no text of the failure when the store cannot read, and logs a fixed line', async () => {
    current = FIRST;
    const lines: string[] = [];
    const rig = await assistantRig({ reply: ASK, threadStore: createMemoryAssistantThreadStore({ failOn: 'read' }), principalId: () => current, logLines: lines });
    const answer = await readThread(rig);
    expect(answer.statusCode).toBe(500);
    expect(answer.json().error).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(answer.body).not.toMatch(/the thread of an investigation could not be read|ASSISTANT_THREAD|SELECT/);
    expect(lines.filter((line) => line.includes('extension.handler_failed'))).toHaveLength(1);
    expect(lines.join('')).not.toMatch(/the thread of an investigation could not be read|ASSISTANT_THREAD|SELECT/);
    await rig.stop();
  });

  it.each([
    ['a store that fails every write', () => createMemoryAssistantThreadStore({ failOn: 'append' })],
    ['a store whose epoch cannot be read', () => createMemoryAssistantThreadStore({ failOn: 'epoch' })],
  ])('answers a turn as before, counts the failed thread write in the health probe by turn id and step, and logs no text, for %s', async (_name, makeStore) => {
    current = FIRST;
    const plain = await assistantRig({ reply: ASK, principalId: () => current });
    const baseline = await send(plain);
    const records = recordsOver();
    const rig = await assistantRig({ reply: ASK, threadStore: makeStore(), recordQueue: records.attached, auditCounts: records.auditCounts, principalId: () => current });
    const answer = await send(rig);
    expect(sameButTokens(answer.json())).toEqual(sameButTokens(baseline.json()));
    await vi.waitFor(() => expect(records.queue.counts().failed).toBe(1));
    const ready = (await rig.rig.app.inject({ method: 'GET', url: '/readyz' })).json();
    expect(ready.audit.failed).toBe(1);
    expect(records.logs.every((line) => line['event'] === 'audit.event_failed' && typeof line['turnId'] === 'string' && typeof line['step'] === 'string')).toBe(true);
    expect(JSON.stringify(records.logs)).not.toContain(CANARY);
    expect([...rig.events, ...rig.rig.events].filter((event) => event.action === 'assistant.turn.closed')).toHaveLength(1);
    await rig.stop();
    await plain.stop();
  });

  it('answers a turn at once while the store of the threads never answers: the write reaches the store, stays queued and is counted as queued in the health probe', async () => {
    current = FIRST;
    const threads = createMemoryAssistantThreadStore();
    const reached = { append: 0 };
    const records = recordsOver();
    const rig = await assistantRig({ reply: ASK, threadStore: { ...threads, append: () => (reached.append++, new Promise(() => undefined)) }, recordQueue: records.attached, auditCounts: records.auditCounts, principalId: () => current });
    const answer = await send(rig);
    expect(answer.statusCode).toBe(200);
    await vi.waitFor(() => expect(reached.append).toBe(1));
    await vi.waitFor(async () => expect((await rig.rig.app.inject({ method: 'GET', url: '/readyz' })).json().audit.queued).toBeGreaterThan(0));
    expect(records.queue.counts()).toMatchObject({ failed: 0, dropped: 0 });
    await rig.stop();
  });

  it('drops what the record queue cannot hold, counted in the health probe', async () => {
    current = FIRST;
    const threads = createMemoryAssistantThreadStore();
    const records = recordsOver(0);
    const rig = await assistantRig({ reply: ASK, threadStore: { ...threads, append: () => new Promise(() => undefined) }, recordQueue: records.attached, auditCounts: records.auditCounts, principalId: () => current });
    const answer = await send(rig);
    expect(answer.statusCode).toBe(200);
    await vi.waitFor(() => expect(records.queue.counts().dropped).toBeGreaterThan(0));
    expect((await rig.rig.app.inject({ method: 'GET', url: '/readyz' })).json().audit.dropped).toBe(records.queue.counts().dropped);
    await rig.stop();
  });
});

describe('a follow-up about an attached summary, through the real application', () => {
  const DRAFT = JSON.stringify({ sentences: [{ text: 'Widget W-1 and widget W-2 are listed.', cites: ['n1', 'n2'] }] });
  const key = (id: string) => JSON.stringify(['node', 'demo', 'widget', id]);

  it('answers from the summary a real draft made: its token opens for this person, the elements are read again through the gate, and an element only the summary cites can be cited', async () => {
    const replies = [DRAFT, '{"route":"view"}', JSON.stringify({ sentences: [{ text: 'Widget W-2 is listed with widget W-1.', cites: ['n2', 'n1'] }] })];
    const rig = await assistantRig({ withSummary: true, runStore: createMemoryAssistantRunStore(), reply: () => replies.shift() ?? '' });
    const drafted = await rig.rig.app.inject({ method: 'POST', url: '/v1/summary', payload: { investigationId: rig.body.investigationId, sourceId: 'demo', entities: [{ sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, { sourceId: 'demo', entityType: 'widget', stableId: 'W-2' }] }, headers: { 'idempotency-key': 'key-0000000000000001' } });
    expect([drafted.statusCode, JSON.stringify(drafted.json())]).toEqual([200, expect.any(String)]);
    const { summaryToken } = drafted.json() as { summaryToken: string };
    const before = rig.rig.executor.calls.length;
    const answer = await rig.post({ ...rig.body, message: 'Which widgets does the summary list?', viewElementKeys: [key('W-1')], summaryToken });
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ status: 'answered', route: 'view', citations: [{ key: 'n2' }, { key: 'n1' }] });
    expect(rig.rig.executor.calls.length).toBeGreaterThan(before);
    expect(rig.stub.bodies[2]).toContain('Widget W-1 and widget W-2 are listed.');
    expect(rig.stub.bodies[1]).not.toContain('are listed');
    await rig.stop();
  });

  it('refuses a token that was altered with the fixed sentence, reading nothing and calling no model', async () => {
    const rig = await assistantRig({ withSummary: true, runStore: createMemoryAssistantRunStore(), reply: () => DRAFT });
    const drafted = await rig.rig.app.inject({ method: 'POST', url: '/v1/summary', payload: { investigationId: rig.body.investigationId, sourceId: 'demo', entities: [{ sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, { sourceId: 'demo', entityType: 'widget', stableId: 'W-2' }] }, headers: { 'idempotency-key': 'key-0000000000000002' } });
    const { summaryToken } = drafted.json() as { summaryToken: string };
    const at = summaryToken.length - 8;
    const altered = `${summaryToken.slice(0, at)}${summaryToken[at] === 'A' ? 'B' : 'A'}${summaryToken.slice(at + 1)}`;
    const calls = rig.stub.bodies.length;
    const before = rig.rig.executor.calls.length;
    const answer = await rig.post({ ...rig.body, message: 'Which widgets does the summary list?', viewElementKeys: [key('W-1')], summaryToken: altered });
    expect(assistantTurnAnswerSchema.parse(answer.json())).toEqual({ status: 'summary-invalid', sentence: 'This summary can no longer be used. Generate it again.' });
    expect(rig.stub.bodies).toHaveLength(calls);
    expect(rig.rig.executor.calls).toHaveLength(before);
    await rig.stop();
  });

  const queues: [string, RecordQueue][] = [
    ['a queue that never writes the records of the summary or of the turn', { enqueue: () => undefined }],
    ['a queue whose writes all fail', { enqueue: (job: RecordJob) => void job.write().catch(() => undefined) }],
  ];

  it.each(queues)('answers the follow-up as it does with the records written, over %s', async (_name, queue) => {
    const replies = [DRAFT, '{"route":"view"}', JSON.stringify({ sentences: [{ text: 'Widget W-2 is listed with widget W-1.', cites: ['n2', 'n1'] }] })];
    const rig = await assistantRig({ withSummary: true, runStore: createMemoryAssistantRunStore(), recordQueue: queue, reply: () => replies.shift() ?? '' });
    const drafted = await rig.rig.app.inject({ method: 'POST', url: '/v1/summary', payload: { investigationId: rig.body.investigationId, sourceId: 'demo', entities: [{ sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, { sourceId: 'demo', entityType: 'widget', stableId: 'W-2' }] }, headers: { 'idempotency-key': 'key-0000000000000004' } });
    expect(drafted.statusCode).toBe(200);
    const { summaryToken } = drafted.json() as { summaryToken: string };
    const answer = await rig.post({ ...rig.body, message: 'Which widgets does the summary list?', viewElementKeys: [key('W-1')], summaryToken });
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ status: 'answered', route: 'view', citations: [{ key: 'n2' }, { key: 'n1' }] });
    await rig.stop();
  });

  it('refuses a token as a summary that cannot be used when the summary is switched off, reading nothing and calling no model', async () => {
    const off = await assistantRig({ withSummary: true, features: { ask: false, summary: false, assistant: true }, runStore: createMemoryAssistantRunStore() });
    const keys = { current: { kid: 'abcd1234', bytes: Buffer.from('7'.repeat(64), 'hex') } };
    const token = sealToken(keys, { investigationId: off.body.investigationId, generatedBy: LOCAL_IDENTITY.principal.id, policyVersion: 'none', modelRef: 'm', promptId: 'case-summary', promptVersion: '1', sentences: [{ text: 'Widget W-1 is listed.', cites: ['n1'] }], inputRefs: [{ key: 'n1', kind: 'entity', ref: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' } }], propertyValuesSent: false, runId: randomUUID(), mask: false, wordListVersion: 2, templates: [{ storable: false, reason: 'unlisted-word' }] }, Date.now());
    const before = off.rig.executor.calls.length;
    const answer = await off.post({ ...off.body, message: 'Which widgets does the summary list?', viewElementKeys: [key('W-1')], summaryToken: token });
    expect(assistantTurnAnswerSchema.parse(answer.json())).toEqual({ status: 'summary-invalid', sentence: 'This summary can no longer be used. Generate it again.' });
    expect(off.stub.bodies).toHaveLength(0);
    expect(off.rig.executor.calls).toHaveLength(before);
    await off.stop();
  });

  it('refuses a summary token on a continue as an invalid request', async () => {
    const rig = await assistantRig({ withSummary: true });
    const { message: _message, ...rest } = rig.body;
    const answer = await rig.post({ ...rest, continue: { intent: 'widgetById', entities: { id: 'W-1' }, continueToken: `${'1'.repeat(10)}.${'a'.repeat(64)}` }, summaryToken: 'v1.x.y.z.w' });
    expect(answer.statusCode).toBe(400);
    expect(answer.json().error).toMatchObject({ code: 'INVALID_REQUEST' });
    await rig.stop();
  });
});

describe('the application tools through the real application', () => {
  const ROUTE = '{"route":"ask","intent":"widgetById","entities":{"id":"W-1"}}';
  const sequence = (...replies: string[]) => {
    let next = 0;
    return () => replies[Math.min(next++, replies.length - 1)] ?? '{"done":true}';
  };
  const entityReads = (rig: Awaited<ReturnType<typeof assistantRig>>) => rig.rig.executor.calls.filter((call) => call.templateId === 'entity-load').length;
  const widgets = (rig: Awaited<ReturnType<typeof assistantRig>>) => (call: ExecuteCall): ExecuteOutcome | undefined => (call.templateId === 'entity-load' ? { status: 'rows', rows: [{ n: widgetNode('W-1') }] } : (void rig, undefined));
  const W1 = { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' };
  const note = (tokenId: string, text: string) => ({
    tokenId,
    generatedBy: 'person-1',
    modelRef: 'claude-sonnet-5-5',
    promptId: 'case-summary',
    promptVersion: '1',
    generatedAt: '2026-11-15T10:00:00.000Z',
    wordListVersion: 2,
    label: 'AI-drafted',
    sentences: [{ text, placeholders: [{ name: '‹widget#1›', descriptor: { kind: 'entity', ref: W1 } }], cites: [{ key: 'n1', kind: 'entity', ref: W1 }] }],
    inputRefs: [{ key: 'n1', kind: 'entity', ref: W1 }],
  });

  it('reads the typology the product ships, with no read of the source, and keeps a sentence that cites its first line', async () => {
    const answerJson = JSON.stringify({ sentences: [{ text: 'A fan-in is when many sources send money to one receiver within a short time.', cites: ['t1'] }] });
    const rig = await assistantRig({ maxSteps: 4, reply: sequence(ROUTE, '{"tool":"typology","values":{}}', '{"done":true}', answerJson), answer: (call) => (call.templateId === 'entity-load' ? { status: 'rows', rows: [{ n: widgetNode('W-1') }] } : undefined) });
    const before = entityReads(rig);
    const answer = await rig.post({ ...rig.body, message: 'Which shape is a fan-in?' });
    expect(entityReads(rig) - before).toBe(1);
    const parsed = assistantTurnAnswerSchema.parse(answer.json());
    expect(parsed).toMatchObject({ status: 'answered', sentences: [{ cites: ['t1'] }], steps: 2 });
    expect(JSON.stringify(parsed)).toContain('"kind":"typology"');
    expect(rig.stub.bodies.at(-1)).toContain('t1:');
    await rig.stop();
  });

  it('shows the agent the key of each typology line it may cite', async () => {
    const answerJson = JSON.stringify({ sentences: [{ text: 'A fan-in is when many sources send money to one receiver within a short time.', cites: ['t1'] }] });
    const rig = await assistantRig({ maxSteps: 4, reply: sequence(ROUTE, '{"tool":"typology","values":{}}', '{"done":true}', answerJson), answer: (call) => (call.templateId === 'entity-load' ? { status: 'rows', rows: [{ n: widgetNode('W-1') }] } : undefined) });
    try {
      await rig.post({ ...rig.body, message: 'Which shape is a fan-in?' });
      expect(rig.stub.bodies.at(-1)).toContain('t5:');
    } finally {
      await rig.stop();
    }
  });

  it('reads the caller\'s own AI notes of the investigation through the application\'s capability, and nobody else\'s', async () => {
    const answerJson = JSON.stringify({ sentences: [{ text: 'Ana Silva is listed.', cites: ['a1'] }] });
    const rig = await assistantRig({ maxSteps: 4, reply: sequence(ROUTE, '{"tool":"ai-notes","values":{}}', '{"done":true}', answerJson), answer: (call) => (call.templateId === 'entity-load' ? { status: 'rows', rows: [{ n: widgetNode('W-1') }] } : undefined) });
    const { store } = rig.rig;
    const mine = store.investigations[0];
    const draft = store.drafts[0];
    if (mine === undefined || draft === undefined) throw new Error('the rig opens an investigation');
    const OTHER = '0192f000-0000-7000-8000-0000000000aa';
    store.drafts[0] = { ...draft, aiNotes: { entries: [note('tok-mine', '‹widget#1› is mine.')] } };
    store.investigations.push({ ...mine, id: OTHER, ownerId: '0192f000-0000-7000-8000-0000000000bb' });
    store.drafts.push({ ...draft, id: '0192f000-0000-7000-8000-0000000000d9', investigationId: OTHER, aiNotes: { entries: [note('tok-other', '‹widget#1› is someone else\'s note.')] } });
    const answer = await rig.post({ ...rig.body, message: 'Show W-1 and my notes' });
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ status: 'answered', sentences: [{ cites: ['r1'] }] });
    const last = rig.stub.bodies.at(-1) ?? '';
    expect(last).toContain('Ana Silva is mine.');
    expect(last).toContain('a1:');
    expect(last).not.toContain("someone else");
    const other = await rig.post({ ...rig.body, investigationId: OTHER, message: 'Show W-1 and my notes' });
    expect(other.statusCode).toBe(404);
    await rig.stop();
  });

  it('does not offer the summary tool while the summary is off, refuses every request for it before anything runs, and ends the turn at its call limit', async () => {
    const rig = await assistantRig({ maxSteps: 4, reply: sequence(ROUTE, '{"tool":"ai-summary","values":{}}', '{"tool":"ai-summary","values":{}}'), answer: (call) => (call.templateId === 'entity-load' ? { status: 'rows', rows: [{ n: widgetNode('W-1') }] } : undefined) });
    const answer = await rig.post({ ...rig.body, message: 'Show W-1 and a summary', viewElementKeys: [JSON.stringify(['node', 'demo', 'widget', 'W-1'])] });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({ status: 'limit', limit: 'calls' });
    const offered = rig.stub.bodies.flatMap((body) => (JSON.parse(body) as { tools?: { name: string }[] }).tools?.map((tool) => tool.name) ?? []);
    expect(offered).toContain('answer');
    expect(offered).not.toContain('ai-summary');
    await rig.stop();
  });

  it('reads the notes as not read, and goes on, when the application refuses them as not the caller\'s while the investigation can be read', async () => {
    const answerJson = JSON.stringify({ sentences: [{ text: 'Ana Silva is listed.', cites: ['r1'] }] });
    const rig = await assistantRig({ maxSteps: 4, reply: sequence(ROUTE, '{"tool":"ai-notes","values":{}}', '{"done":true}', answerJson), answer: (call) => (call.templateId === 'entity-load' ? { status: 'rows', rows: [{ n: widgetNode('W-1') }] } : undefined) });
    // the investigation is the caller's and can be read, but the store finds no notes for it: the application's read of them is `NOT_FOUND`
    rig.rig.store.readAiNotes = async () => ({ outcome: 'not-found' });
    const answer = await rig.post({ ...rig.body, message: 'Show W-1 and my notes' });
    expect(answer.statusCode).toBe(200);
    expect(JSON.stringify(answer.json())).toContain('"kind":"ai-notes"');
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ status: 'answered' });
    await rig.stop();
  });

  it('drafts the AI case summary of the view in the turn with the real summarizer, counts its model call, and answers from its sentence by the elements it rests on', async () => {
    const summaryJson = JSON.stringify({ sentences: [{ text: 'Ana Silva is a widget.', cites: ['n1'] }] });
    const answerJson = JSON.stringify({ sentences: [{ text: 'Ana Silva is a widget.', cites: ['a1'] }] });
    const rig = await assistantRig({ withSummary: true, threadStore: createMemoryAssistantThreadStore(), maxSteps: 4, reply: sequence(ROUTE, '{"tool":"ai-summary","values":{}}', summaryJson, '{"done":true}', answerJson), answer: (call) => (call.templateId === 'entity-load' ? { status: 'rows', rows: [{ n: widgetNode('W-1') }] } : undefined) });
    const answer = await rig.post({ ...rig.body, message: 'Show W-1 and summarize the view', viewElementKeys: [JSON.stringify(['node', 'demo', 'widget', 'W-1'])] });
    expect(assistantTurnAnswerSchema.parse(answer.json())).toMatchObject({ status: 'answered', calls: 5, sentences: [{ text: 'Ana Silva is a widget.' }] });
    expect(JSON.stringify(answer.json())).toContain('"kind":"ai-summary"');
    expect(rig.stub.bodies).toHaveLength(5);
    await rig.stop();
  });
});

describe('the properties in the lines of a tool result, through the real application', () => {
  const ROUTE = '{"route":"ask","intent":"widgetById","entities":{"id":"W-1"}}';
  const sequence = (...replies: string[]) => {
    let next = 0;
    return () => replies[Math.min(next++, replies.length - 1)] ?? '{"done":true}';
  };
  const ANSWER = JSON.stringify({ sentences: [{ text: 'Widget W-1 is listed.', cites: ['r1'] }] });
  const run = async (mask: boolean) => {
    const rig = await assistantRig({ maxSteps: 4, threadStore: createMemoryAssistantThreadStore(), reply: sequence(ROUTE, '{"tool":"typology","values":{}}', '{"done":true}', ANSWER), answer: (call) => (call.templateId === 'entity-load' ? { status: 'rows', rows: [{ n: widgetNode('W-1') }] } : undefined) });
    const answer = await rig.post({ ...rig.body, message: 'Show W-1', mask });
    const closing = [...rig.events, ...rig.rig.events].find((event) => event.action === 'assistant.turn.closed');
    const answerCall = rig.stub.bodies.at(-1) ?? '';
    await rig.stop();
    return { answer, closing, answerCall, bodies: rig.stub.bodies };
  };

  it('writes the value of a property that is not masked into the answer call, and records that property values were sent', async () => {
    const { answer, closing, answerCall } = await run(false);
    expect(answer.statusCode).toBe(200);
    expect(answerCall).toContain('widgetId: ');
    expect(answerCall).toContain('Ana Silva');
    expect(closing).toMatchObject({ detail: { turn: { propertyValuesSent: true } } });
  });

  it('with masking on, never sends the unmasked value of a masked property to the model service, and writes its masked form with the mark', async () => {
    const { answer, closing, answerCall, bodies } = await run(true);
    expect(answer.statusCode).toBe(200);
    expect(answerCall).toContain('(masked)');
    for (const body of bodies) expect(body).not.toContain('Ana Silva');
    expect(closing).toMatchObject({ detail: { turn: { propertyValuesSent: true } } });
    expect(JSON.stringify(closing)).not.toContain('Ana Silva');
  });
});

describe('the larger of two amounts in the lines of a tool result, through the real application', () => {
  const REPLY = '{"route":"ask","intent":"queryById","entities":{"id":"W-1"}}';
  const named = (id: string, name: string) => ({ $type: 'node', elementId: `4:s:${id}`, labels: ['Widget'], properties: { widgetId: id, ownerName: name } });
  const sequence = (...replies: string[]) => {
    let next = 0;
    return () => replies[Math.min(next++, replies.length - 1)] ?? '{"done":true}';
  };
  const turn = async (sentences: { text: string; cites: string[] }[]) => {
    const answerJson = JSON.stringify({ sentences });
    const rig = await assistantRig({ maxSteps: 4, reply: sequence(REPLY, '{"tool":"typology","values":{}}', '{"done":true}', answerJson, answerJson), fileQuery: { status: 'rows', rows: [{ n: named('W-1', '4200') }, { n: named('W-2', '5000') }] } });
    const answer = await rig.post({ ...rig.body, message: 'Query widget W-1' });
    const answerCall = rig.stub.bodies.at(-1) ?? '';
    await rig.stop();
    return { answer: answer.json() as Record<string, unknown>, answerCall };
  };

  it('writes the values of each element into its own line, and says that the read listed no relationship', async () => {
    const { answerCall } = await turn([{ text: 'The larger is 5000, against 4200.', cites: ['r1', 'r2'] }]);
    expect(answerCall).toContain('ownerName: \\"4200\\"');
    expect(answerCall).toContain('ownerName: \\"5000\\"');
    expect(answerCall).toContain('no relationship listed');
  });

  it('keeps the larger named from two lines that both show an amount, and the largest named from one line only with the line of the read', async () => {
    expect(await turn([{ text: 'The larger is 5000, against 4200.', cites: ['r1', 'r2'] }])).toMatchObject({ answer: { status: 'answered', sentences: [{ cites: ['r1', 'r2'] }] } });
    expect(await turn([{ text: '5000 is the largest of those shown.', cites: ['r2', 's1'] }])).toMatchObject({ answer: { status: 'answered' } });
  });

  it('drops the largest named from one line while another element of the read is not cited, and an amount that no cited line holds', async () => {
    expect(JSON.stringify((await turn([{ text: '5000 is the largest.', cites: ['r2'] }])).answer)).not.toContain('5000 is the largest.');
    expect(JSON.stringify((await turn([{ text: 'The larger is 5000, against 4300.', cites: ['r1', 'r2'] }])).answer)).not.toContain('against 4300');
  });
});

describe('a table answer through the real application', () => {
  const sequence = (...replies: string[]) => {
    let next = 0;
    return () => replies[Math.min(next++, replies.length - 1)] ?? '{"done":true}';
  };
  const ROUTER = '{"route":"view","form":"table"}';
  const key = (id: string) => JSON.stringify(['node', 'demo', 'widget', id]);
  const table = (rows: { cells: string[]; cites: string[] }[]) => JSON.stringify({ columns: ['Element', 'Type'], rows });
  const turn = async (reply: string, mask: boolean) => {
    const rig = await assistantRig({ maxSteps: 4, reply: sequence(ROUTER, '{"tool":"view","values":{}}', '{"done":true}', reply), answer: (call) => (call.templateId === 'entity-load' ? { status: 'rows', rows: [{ n: widgetNode('W-1') }] } : undefined) });
    const answer = await rig.post({ ...rig.body, message: 'Show the elements as a table', viewElementKeys: [key('W-1')], mask });
    const bodies = [...rig.stub.bodies];
    await rig.stop();
    return { answer: answer.json() as Record<string, unknown>, bodies };
  };

  it('answers a table when the router chose the form', async () => {
    const { answer } = await turn(table([{ cells: ['W-1', 'widget'], cites: ['n1'] }]), false);
    expect(answer).toMatchObject({ status: 'answered', route: 'view', table: { columns: ['Element', 'Type'], rows: [{ cells: ['W-1', 'widget'], cites: ['n1'] }] } });
  });

  it('with masking on, never sends the unmasked value of a masked property, and drops a row that writes it', async () => {
    const { answer, bodies } = await turn(table([{ cells: ['Ana Silva', 'widget'], cites: ['n1'] }, { cells: ['W-1', 'widget'], cites: ['n1'] }]), true);
    // the requests after the model's own call of answer carry back what it wrote: only those before it show what the product sent
    const sent = bodies.filter((body) => !body.includes('toolu_answer'));
    expect(sent.length).toBeGreaterThanOrEqual(3);
    for (const body of sent) expect(body).not.toContain('Ana Silva');
    expect(JSON.stringify(answer)).not.toContain('Ana Silva');
    expect(answer).toMatchObject({ status: 'answered', table: { rows: [{ cells: ['W-1', 'widget'] }], droppedRows: 1 } });
  });
});

