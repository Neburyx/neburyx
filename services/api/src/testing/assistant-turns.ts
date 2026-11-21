import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuditEvent, RecordJob } from '@neburyx/contracts';
import { createEnterpriseExtension, createMemoryAssistantRunStore, createMemoryAssistantPendingStore, createMemoryAssistantThreadStore } from '@neburyx/ee-ask';
import { createEventQueue } from '../audit/queue.js';
import { fileQueryDepsOf } from '../gate/file-query.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { makeAskFolder } from './ask-folder.js';
import { startExportRig } from './export-rig.js';

/** A reply the stand-in does not answer until the test says so (or never): the call stays pending at the model. */
export const HOLD = { hold: true } as const;
type Reply = string | typeof HOLD;

/** A stand-in for the model service on the loopback address: the next reply for each request, `HOLD` for a call that stays pending, and the body of every request it received. */
export interface TurnModel {
  readonly baseUrl: string;
  readonly requests: string[];
  readonly replies: Reply[];
  /** The calls that are pending now: held, not answered, and not given up by the caller (a call the application aborts leaves this count). */
  held(): number;
  /** Answers every held call with the reply given, and holds no later call. */
  release(reply: string): void;
  reset(): void;
  close(): Promise<void>;
}

const NO_REPLY = '{"route":"refuse","cause":"unplaced"}';

/** `reply` answers every request from its body instead of the queue: a load of many turns that make their calls in any order. */
export async function startTurnModel(reply?: (body: string) => string): Promise<TurnModel> {
  const requests: string[] = [];
  const replies: Reply[] = [];
  const pending: Array<(reply: string) => void> = [];
  let open = true;
  const answer = (response: import('node:http').ServerResponse, text: string): void => {
    if (response.destroyed) return;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4 } }));
  };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push(Buffer.concat(chunks).toString('utf8'));
      const next = reply === undefined ? (replies.shift() ?? NO_REPLY) : reply(requests[requests.length - 1] ?? '');
      if (next === HOLD && open) {
        const entry = (text: string): void => answer(response, text);
        pending.push(entry);
        response.on('close', () => {
          const at = pending.indexOf(entry);
          if (at >= 0) pending.splice(at, 1);
        });
        return;
      }
      answer(response, typeof next === 'string' ? next : NO_REPLY);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    replies,
    held: () => pending.length,
    release: (reply) => {
      open = false;
      for (const answerHeld of pending.splice(0)) answerHeld(reply);
    },
    reset: () => {
      requests.length = 0;
      replies.length = 0;
      pending.length = 0;
      open = true;
    },
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface AssistantAppOptions {
  readonly model: { readonly baseUrl: string };
  /** What the scripted source answers for a read; undefined leaves it to the rig's own answers. */
  readonly respond?: (call: ExecuteCall) => ExecuteOutcome | Promise<ExecuteOutcome> | undefined;
  /** The most steps of a turn; the loop is on from two. */
  readonly maxSteps?: number;
  readonly maxCalls?: number;
  /** The name the source gives an entity read by its stable id. */
  readonly name?: (id: string) => string;
  /** Mounts the stores of the extension (memory ones here), which the confirmation of a heavy step needs: it is kept in a store of its own. */
  readonly stores?: boolean;
  /** Turns the AI case summary on (the summarizer reads its own token key from an owner-only file made here). */
  readonly summary?: boolean;
  /** Settings of the assistant, by name (`NEBURYX_ASSISTANT_*`). */
  readonly settings?: Readonly<Record<string, string>>;
  /** A description for a type of the source's mapping, by the name of the type. */
  readonly descriptions?: Readonly<Record<string, string>>;
  /** The `synthetic` flag of the source in the mapping; absent, the mapping does not set it. */
  readonly synthetic?: boolean;
  /** Whether the preview is on for the application; it is, unless a case turns it off. */
  readonly previewOn?: boolean;
  /** The person each request is made by: a second person is a function that answers another id. */
  readonly principalId?: () => string;
  /** The clock of the extension (the lifetime of a choice or follow-up token is read from it). */
  readonly now?: () => number;
  /** Keeps the person's thread: the memory store of the thread and the queue that writes each turn's record to it, which a follow-up of an earlier turn needs. */
  readonly threads?: boolean;
}

const INTENTS = {
  widgetById: { parameters: ['id'], template: 'entity', settings: { ref: { entityType: 'widget', stableId: '$id' } } },
  findWidgets: { parameters: ['q'], template: 'search', settings: { entityTypes: ['widget'], text: '$q' } },
  byId: { parameters: ['id'], query: 'MATCH (n:Widget) WHERE n.widgetId = $id RETURN n LIMIT 5' },
  sharedGadget: { parameters: ['id'], template: 'shared-attribute', settings: { ref: { entityType: 'widget', stableId: '$id' }, attributeType: 'gadget', via: 'MADE_FROM' } },
};

function tokenKeyFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'nbx-assistant-key-')), 'token.key');
  writeFileSync(file, `${'7'.repeat(64)}\n`);
  chmodSync(file, 0o600);
  return file;
}

export type AssistantApp = Awaited<ReturnType<typeof startAssistantApp>>;

/** The real application with the real enterprise extension and the assistant on (its tool loop from two steps), over a model service the test gives and the real gate over a scripted source. */
export async function startAssistantApp(options: AssistantAppOptions) {
  const threadStore = createMemoryAssistantThreadStore();
  const extension = createEnterpriseExtension({ modelBaseUrl: options.model.baseUrl, assistantRunStore: () => createMemoryAssistantRunStore(), assistantThreadStore: () => threadStore, assistantPendingStore: () => createMemoryAssistantPendingStore(), ...(options.now === undefined ? {} : { now: options.now }) });
  const records = options.threads === true ? createEventQueue<RecordJob>({ sinks: [{ name: 'run-records', sink: { record: (job) => job.write() } }], idFields: (job) => job.ids, settings: { queueSize: 100, retryLimit: 0, retryWaitMs: 10, writeTimeoutMs: 1000 }, logger: { warn: () => undefined } }) : undefined;
  if (records !== undefined) extension.attachRecordQueue?.({ enqueue: (job) => void records.sink.record(job) });
  const env = {
    NEBURYX_ASK_API_KEY: 'not-a-real-key',
    NEBURYX_ASK_MAPPING_FOLDER: makeAskFolder(['demo'], INTENTS),
    NEBURYX_ASK_MAX_RETRIES: '0',
    NEBURYX_ASK_TIMEOUT_MS: '5000',
    NEBURYX_ASSISTANT_MAX_STEPS: String(options.maxSteps ?? 4),
    ...(options.maxCalls === undefined ? {} : { NEBURYX_ASSISTANT_MAX_CALLS: String(options.maxCalls) }),
    ...(options.summary === true ? { NEBURYX_SUMMARY_TOKEN_KEY_FILE: tokenKeyFile(), NEBURYX_SUMMARY_MAX_INPUT_TOKENS: '100000' } : {}),
    ...options.settings,
  };
  const configured = await extension.configure?.({}, env, { sourceIds: ['demo'], features: { ask: false, summary: options.summary === true, assistant: true } });
  if (configured?.ok !== true) throw new Error(`the extension was not configured: ${JSON.stringify(configured)}`);
  const sinkOpened = options.stores === true || options.threads === true ? extension.createAuditSink?.({ databaseUrl: 'postgres://app@db.example.test:5432/neburyx', poolSize: 1, connectionTimeoutMs: 100, statementTimeoutMs: 100, queryTimeoutMs: 100, newId: () => randomUUID(), onConnectionError: () => undefined }) : undefined;
  const modelEvents: AuditEvent[] = [];
  extension.attachAudit?.({ record: (event) => (modelEvents.push(event), Promise.resolve()) });
  const logs: string[] = [];
  const armed = { open: false };
  const rig = await startExportRig({ extension, ...(options.synthetic === undefined ? {} : { synthetic: options.synthetic }), ...(options.principalId === undefined ? {} : { principal: () => ({ id: options.principalId?.() ?? '' }) }), ...(options.descriptions === undefined ? {} : { descriptions: options.descriptions }), links: ['L-1'], previewOn: options.previewOn ?? true, directAudit: true, logLines: logs, ...(options.name === undefined ? {} : { name: options.name }), fileQueries: fileQueryDepsOf(() => extension.askFolder()), answer: (call) => (armed.open ? options.respond?.(call) : undefined) });
  const investigation = await rig.open();
  armed.open = true;
  const body = (message: string, over: Record<string, unknown> = {}) => ({ sourceId: 'demo', investigationId: investigation.id, message, viewElementKeys: [], ...over });
  let address: string | undefined;
  return {
    app: rig.app,
    store: rig.store,
    executor: rig.executor,
    logs,
    /** The events of the application and of the extension's own sink: the gate's, the routes' and the model calls'. */
    events: (): AuditEvent[] => [...modelEvents, ...rig.events],
    /** The reads that reached the source, without the schema reads of its start. */
    reads: (): ExecuteCall[] => rig.executor.calls.filter((call) => !call.templateId.startsWith('schema-')),
    /** One turn through the application's own route. */
    turn: async (message: string, over: Record<string, unknown> = {}) => {
      const response = await rig.app.inject({ method: 'POST', url: '/v1/assistant/turns', payload: body(message, over) });
      return { status: response.statusCode, body: response.json() as Record<string, unknown>, headers: response.headers };
    },
    /** What the person's thread holds, as stored: the rows a test scans for text that must not be kept. */
    threadRows: (): string => JSON.stringify([...threadStore.threads.values()]),
    /** The investigation the turns are made in. */
    investigationId: investigation.id,
    /** Opens another investigation of the same person on the same source. */
    openInvestigation: async (): Promise<string> => (await rig.open()).id,
    /** A request of any form to the turn route, as given (a choice, a continue or a decision has no message). */
    post: async (payload: Record<string, unknown>) => {
      const response = await rig.app.inject({ method: 'POST', url: '/v1/assistant/turns', payload });
      return { status: response.statusCode, body: response.json() as Record<string, unknown>, headers: response.headers };
    },
    /** Waits until the thread holds `count` turns written by the queue of the records. */
    threadWritten: async (count: number): Promise<void> => {
      for (let wait = 0; wait < 200 && (records?.counts().written ?? 0) < count; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      if ((records?.counts().written ?? 0) < count) throw new Error(`the thread holds ${records?.counts().written ?? 0} records, not ${count}`);
    },
    /** One turn over the real connection, which the caller may abort. */
    sendTurn: async (message: string, signal: AbortSignal, over: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
      address ??= await rig.app.listen({ host: '127.0.0.1', port: 0 });
      return fetch(`${address}/v1/assistant/turns`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body(message, over)), signal }).catch(() => undefined);
    },
    close: async () => {
      await rig.stop();
      await sinkOpened?.close();
    },
  };
}
