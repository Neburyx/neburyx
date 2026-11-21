import type { AskFolder, AuditEvent, ProfileExtension } from '@neburyx/contracts';
import { fileQueryDepsOf } from '../../../services/api/src/gate/file-query.js';
import type { ExecuteCall, ExecuteOutcome } from '../../../services/api/src/gate/executor.js';
import type { MappingModel } from '../../../services/api/src/mapping/model.js';
import type { TemplateProbe } from '../../../services/api/src/graph/template-probes.js';
import { DEFINITION, OTHER_IDENTITY, SAVED_PATTERN_MAPPING, patternApp, type PatternApp } from '../../../services/api/src/testing/saved-pattern-rig.js';
import { lookupAnswer } from '../../../services/api/src/testing/held-elements.js';
import { searchMappingOf, startSearchApp, type SearchApp } from '../../../services/api/src/testing/search-app.js';
import { modelEvents } from './mock-audit.js';
import type { ModelStub } from './stub.js';

/** The part of the enterprise extension the rig uses; a test file builds the real one, so this package's rig imports no enterprise package. */
type AskExtension = ProfileExtension & { askFolder?(): AskFolder | undefined };

export const JSON_HEADERS = { 'content-type': 'application/json' };
const SOURCE_ID = 'demo';

export type RunRow = object;

/** A run store that records its rows in memory, as the `runStore` option of the extension takes it. */
export function recordingRunStore(): { readonly rows: RunRow[]; readonly factory: () => { record(row: RunRow): Promise<void>; close(): Promise<void> } } {
  const rows: RunRow[] = [];
  return { rows, factory: () => ({ record: (row) => (rows.push(row), Promise.resolve()), close: () => Promise.resolve() }) };
}

export interface RigOptions {
  readonly extension: AskExtension;
  readonly stub: ModelStub;
  readonly rows: readonly RunRow[];
  /** The Ask folder: a directory holding one subfolder for each source. */
  readonly folder: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly mapping?: MappingModel;
  readonly respond?: (call: ExecuteCall) => Promise<ExecuteOutcome>;
  /** The elements the scripted source holds for the lookup of a written value, as `type/id`; absent, it holds every one asked for. */
  readonly held?: readonly string[];
  readonly sourceIds?: readonly string[];
  /** The folder the gate checks and runs a file query from: the extension's own unless a case forces another (a query that the extension's folder does not hold). */
  readonly gateFolder?: () => AskFolder | undefined;
  /** The text check of the gate; the real one unless a case forces a write past it to meet the next layer. */
  readonly textCheck?: Parameters<typeof fileQueryDepsOf>[1];
}

export interface Rig {
  readonly app: SearchApp['app'];
  readonly executor: SearchApp['executor'];
  readonly stub: ModelStub;
  /** The events of the application's audit seam: the route's and the gate's. */
  readonly appEvents: AuditEvent[];
  /** The events of the extension's own sink: the classification's model calls. */
  readonly modelEvents: AuditEvent[];
  readonly rows: readonly RunRow[];
  readonly logs: string[];
  /** The reads that reached the source, without the schema reads of its start. */
  reads(): ExecuteCall[];
  ask(question: string, reply: string, over?: Record<string, unknown>): Promise<{ readonly status: number; readonly body: Record<string, unknown> }>;
  post(url: string, payload: unknown): Promise<{ readonly status: number; readonly body: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** The real application with the extension a test file built, configured on the folder: the extension's own classifier and provider over the stand-in, the real gate over a scripted executor, and every record kept. */
export async function startRig(options: RigOptions): Promise<Rig> {
  const { extension, stub } = options;
  stub.reset();
  modelEvents.length = 0;
  const env = { NEBURYX_ASK_API_KEY: 'not-a-real-key', NEBURYX_ASK_MAPPING_FOLDER: options.folder, NEBURYX_ASK_MAX_RETRIES: '0', NEBURYX_ASK_TIMEOUT_MS: '5000', ...options.env };
  const configured = await extension.configure?.({ preview: true }, env, { sourceIds: options.sourceIds ?? [SOURCE_ID] });
  if (configured?.ok !== true) throw new Error(`the extension was not configured: ${JSON.stringify(configured)}`);
  extension.createAuditSink?.({ databaseUrl: 'postgres://app@127.0.0.1:1/neburyx', poolSize: 1, connectionTimeoutMs: 100, statementTimeoutMs: 100, queryTimeoutMs: 100, newId: () => crypto.randomUUID(), onConnectionError: () => undefined });
  const appEvents: AuditEvent[] = [];
  const rig = await startSearchApp({
    ...(options.mapping === undefined ? {} : { mapping: options.mapping }),
    // the lookup of a written value is a batched read of elements: the scripted source holds the widgets it is asked for, and every other read is the case's own
    ...(options.respond === undefined ? {} : { respond: async (call: ExecuteCall) => (await lookupAnswer(call, options.mapping ?? searchMappingOf(), options.respond, options.held)) as ExecuteOutcome }),
    audit: { record: (event) => (appEvents.push(event), Promise.resolve()) },
    fileQueries: fileQueryDepsOf(options.gateFolder ?? (() => extension.askFolder?.()), options.textCheck),
    appOptions: { extension, previewOn: true },
  });
  const send = async (url: string, payload: unknown) => {
    const response = await rig.app.inject({ method: 'POST', url, payload: JSON.stringify(payload), headers: JSON_HEADERS });
    return { status: response.statusCode, body: response.json() as Record<string, unknown> };
  };
  return {
    app: rig.app,
    executor: rig.executor,
    stub,
    appEvents,
    modelEvents,
    rows: options.rows,
    logs: rig.lines,
    reads: () => rig.executor.calls.filter((call) => !call.templateId.startsWith('schema-')),
    ask: (question, reply, over = {}) => {
      stub.replies.push(reply);
      return send('/v1/ask', { sourceId: SOURCE_ID, question, ...over });
    },
    post: send,
    close: () => rig.app.close(),
  };
}

export interface PatternRig {
  readonly app: PatternApp['app'];
  readonly store: PatternApp['store'];
  readonly executor: PatternApp['executor'];
  readonly stub: ModelStub;
  readonly appEvents: AuditEvent[];
  readonly modelEvents: AuditEvent[];
  readonly rows: readonly RunRow[];
  readonly logs: string[];
  /** A pattern saved as the person of the rig, or as another person: the id it was saved under. */
  save(name: string, body?: Record<string, unknown>): Promise<string>;
  ask(question: string, reply: string): Promise<{ readonly status: number; readonly body: Record<string, unknown> }>;
  post(url: string, payload: unknown): Promise<{ readonly status: number; readonly body: Record<string, unknown> }>;
  /** Another person of the same store, who saves a private and a shared pattern of their own. */
  saveAsOther(name: string, visibility: 'private' | 'shared'): Promise<string>;
  close(): Promise<void>;
}

/** The same rig on the mapping of the saved patterns: a person who has patterns of their own, and another person who has a private and a shared one. */
export async function startPatternRig(options: { readonly extension: AskExtension; readonly stub: ModelStub; readonly rows: readonly RunRow[]; readonly folder: string; readonly env?: Readonly<Record<string, string>>; readonly answer?: (call: ExecuteCall) => Promise<ExecuteOutcome>; readonly probes?: ReadonlyMap<string, TemplateProbe> }): Promise<PatternRig> {
  const { extension, stub } = options;
  stub.reset();
  modelEvents.length = 0;
  const env = { NEBURYX_ASK_API_KEY: 'not-a-real-key', NEBURYX_ASK_MAPPING_FOLDER: options.folder, NEBURYX_ASK_MAX_RETRIES: '0', NEBURYX_ASK_TIMEOUT_MS: '5000', ...options.env };
  const configured = await extension.configure?.({ preview: true }, env, { sourceIds: [SOURCE_ID] });
  if (configured?.ok !== true) throw new Error(`the extension was not configured: ${JSON.stringify(configured)}`);
  extension.createAuditSink?.({ databaseUrl: 'postgres://app@127.0.0.1:1/neburyx', poolSize: 1, connectionTimeoutMs: 100, statementTimeoutMs: 100, queryTimeoutMs: 100, newId: () => crypto.randomUUID(), onConnectionError: () => undefined });
  const logs: string[] = [];
  const answerOf = options.answer ?? (() => Promise.resolve({ status: 'rows' as const, rows: [] }));
  const context = await patternApp({ answer: async (call: ExecuteCall) => (await lookupAnswer(call, SAVED_PATTERN_MAPPING, answerOf)) as ExecuteOutcome, extension, logLines: logs, ...(options.probes === undefined ? {} : { probes: options.probes }) });
  const other = await patternApp({ sharing: context.store, identity: OTHER_IDENTITY });
  const save = async (who: PatternApp, name: string, extra: Record<string, unknown>): Promise<string> => {
    const response = await who.app.inject({ method: 'POST', url: '/v1/patterns', payload: { sourceId: SOURCE_ID, name, kind: 'definition', definition: DEFINITION, ...extra }, headers: JSON_HEADERS });
    if (response.statusCode !== 201) throw new Error(`a pattern was not saved: ${response.statusCode}`);
    return (response.json() as { id: string }).id;
  };
  const send = async (url: string, payload: unknown) => {
    const response = await context.app.inject({ method: 'POST', url, payload: JSON.stringify(payload), headers: JSON_HEADERS });
    return { status: response.statusCode, body: response.json() as Record<string, unknown> };
  };
  return {
    app: context.app,
    store: context.store,
    executor: context.executor,
    stub,
    appEvents: context.audit.events,
    modelEvents,
    rows: options.rows,
    logs,
    save: (name, body = {}) => save(context, name, body),
    saveAsOther: async (name, visibility) => {
      const id = await save(other, name, {});
      const row = other.store.patternRows.find((held) => held.id === id);
      if (row === undefined) throw new Error('not saved');
      other.store.patternRows.splice(other.store.patternRows.indexOf(row), 1, { ...row, visibility });
      return id;
    },
    ask: (question, reply) => {
      stub.replies.push(reply);
      return send('/v1/ask', { sourceId: SOURCE_ID, question });
    },
    post: send,
    close: async () => {
      await context.app.close();
      await other.app.close();
    },
  };
}
