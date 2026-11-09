import { rmSync } from 'node:fs';
import { expect } from 'vitest';
import { Agent, request as httpRequest } from 'node:http';
import { buildApp } from '../../../services/api/src/app.js';
import type { ExecuteCall, ExecuteOutcome } from '../../../services/api/src/gate/executor.js';
import { edgeRefSegmentOf, sourceLinkSegmentOf } from '@neburyx/contracts';
import { EDGE_LOAD_ID } from '../../../services/api/src/gate/templates/edge-load.js';
import { ENTITY_LOAD_ID } from '../../../services/api/src/gate/templates/entity-load.js';
import type { Gate } from '../../../services/api/src/gate/types.js';
import { createLogger } from '../../../services/api/src/logger.js';
import { parseMapping } from '../../../services/api/src/mapping/load.js';
import { createRequestLimiter, type RequestLimiter } from '../../../services/api/src/rate/request-limiter.js';
import { withBreaker } from '../../../services/api/src/seams/breaker.js';
import { createReadSlots, type ReadSlots, type SetTimer } from '../../../services/api/src/seams/read-slots.js';
import type { Coordinator, Principal, ReadAccessRequest, ReadAdmission, Seams } from '../../../services/api/src/seams/seams.js';
import { communityAudit, communityPolicy } from '../../../services/api/src/seams/community-seams.js';
import { memoryAppStore } from '../../../services/api/src/testing/app-store.js';
import { entityRows } from '../../../services/api/src/testing/entity-fixtures.js';
import { LOCAL_PRINCIPAL, TestExecutor, gateRequest } from '../../../services/api/src/testing/gate.js';
import { baseSource, fileOf } from '../../../services/api/src/testing/mapping.js';
import { plainNode, plainRelationship } from '../../../services/api/src/testing/normalize-fixtures.js';
import { portOf } from '../../../services/api/src/testing/raw-request.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../../../services/api/src/testing/search-fixtures.js';
import { testSourceGate } from '../../../services/api/src/testing/source-gate.js';
import { makeWebRoot } from '../../../services/api/src/testing/web-root.js';

export const SOURCE = 'demo';
const edgePathOf = (sourceId: string): string => `/v1/edges/${edgeRefSegmentOf({ sourceId, type: 'LINKS', from: 'node_a', to: 'node_b', stableId: 'L-1' })}`;
export const OTHER_SOURCE = 'other';
const LINKED_ENTITIES = [
  { type: 'node_a', label: 'NodeA', stable_id: 'id', link: 'https://records.example.test/{id}' },
  { type: 'node_b', label: 'NodeB', stable_id: 'key' },
];
const linkPathOf = (sourceId: string): string => `/v1/source-links/${sourceLinkSegmentOf({ form: 'entity', ref: { sourceId, entityType: 'node_a', stableId: 'H-1' } })}`;
const START = 1_000_000;

/** The body of an answer, empty for a redirect. */
const parsedBody = (text: string): HttpAnswer['body'] => (text === '' ? {} : JSON.parse(text));

/** What the scripted source does with a data read: keep it until the test says, or answer at once. */
export type Mode = 'hold' | 'answer' | 'timeout';

export interface HeldRead {
  readonly sourceId: string;
  readonly traceId: string;
  answer(): void;
  timeOut(): void;
  fail(): void;
}

export interface HttpAnswer {
  readonly status: number;
  readonly body: { readonly error?: { readonly code: string; readonly retryable?: boolean; readonly details?: { readonly reason?: string; readonly retryAfterMs?: number; readonly timeoutMs?: number } } } & Record<string, unknown>;
  readonly retryAfter: string | null;
}

export interface Rig {
  readonly now: () => number;
  readonly slots: ReadSlots;
  readonly limiter: RequestLimiter;
  readonly gate: Gate;
  readonly executor: TestExecutor;
  mode: Mode;
  readonly held: HeldRead[];
  readonly data: { started: number; inFlight: number; peak: number };
  startedAt(sourceId: string): number;
  http(sourceId?: string, route?: Route): Promise<HttpAnswer>;
  asPerson(person: Principal, sourceId?: string, signal?: AbortSignal): Promise<unknown>;
  get(path: string): Promise<number>;
  advance(ms: number): Promise<void>;
  settle(): Promise<void>;
  until(check: () => boolean, what: string): Promise<void>;
  personHolds(person?: Principal, sourceId?: string): { held: number; waiting: number };
  readonly roles: string[];
  close(): Promise<void>;
}

export interface RigOptions {
  readonly budgets?: Record<string, number>;
  readonly otherBudgets?: Record<string, number>;
  /** Wraps the coordinator, for a read that never releases. */
  readonly wrap?: (inner: Coordinator) => Coordinator;
}

/** A person other than the local one; the Community policy allows everyone. */
export const personNumber = (n: number): Principal => ({ ...LOCAL_PRINCIPAL, id: `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`, displayName: `Person ${n}` });

const NODE = plainNode(['NodeA'], { id: 'H-1' });
const NODE_B = plainNode(['NodeB'], { key: 'K-1' }, '4:fixture:2');
const EDGE_ROWS: ExecuteOutcome = { status: 'rows', rows: [{ r: plainRelationship('LINKS', NODE, NODE_B, { relId: 'L-1' }), a: NODE, b: NODE_B }] };
export const EDGE_PATH = `/v1/edges/${edgeRefSegmentOf({ sourceId: SOURCE, type: 'LINKS', from: 'node_a', to: 'node_b', stableId: 'L-1' })}`;

/** Which read route `http` calls: the entity read, the stored edge read, or the source link of the entity. */
export type Route = 'entity' | 'edge' | 'link';

/** Fake timers: set at a time of the shared clock, fired in order of time and then of setting. */
function timers(clock: { now: number }) {
  interface Entry { at: number; order: number; run: () => void; live: boolean }
  const entries: Entry[] = [];
  let order = 0;
  const setTimer: SetTimer = (run, ms) => {
    const entry: Entry = { at: clock.now + ms, order: order++, run, live: true };
    entries.push(entry);
    return { cancel: () => void (entry.live = false) };
  };
  const next = (limit: number): Entry | undefined => entries.filter((entry) => entry.live && entry.at <= limit).sort((a, b) => a.at - b.at || a.order - b.order)[0];
  return { setTimer, next };
}

/** Lets pending I/O and promise steps land: a fixed number of turns of the event loop, not a wait for time. */
export const flush = async (turns = 20): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

/**
 * The real API on a loopback port with the real gate, read slots, request limiter and circuit breaker, composed as the Community seams are, over a scripted source. The one clock of the gate, the slots'
 * timers, the breaker and the limiter is the test's: a wait, a lease's expiry, a window and a cool-down pass only when the test advances it.
 */
export async function startRig(options: RigOptions = {}): Promise<Rig> {
  const mapping = parseMapping(
    fileOf(baseSource({ id: SOURCE, entities: LINKED_ENTITIES, relationships: [{ type: 'LINKS', from: 'node_a', to: 'node_b', stable_id: 'relId' }], ...(options.budgets === undefined ? {} : { budgets: options.budgets }) }), baseSource({ id: OTHER_SOURCE, entities: LINKED_ENTITIES, relationships: [{ type: 'LINKS', from: 'node_a', to: 'node_b', stable_id: 'relId' }], ...(options.otherBudgets === undefined ? {} : { budgets: options.otherBudgets }) })),
    'neburyx.yaml',
  );
  const clock = { now: START };
  const { setTimer, next } = timers(clock);
  const slots = createReadSlots({ setTimer });
  const breaker = withBreaker(slots, { clock: () => clock.now, setTimer });
  const roles: string[] = [];
  const recording: Coordinator = { acquireRead: (request: ReadAccessRequest): Promise<ReadAdmission> => (roles.push(request.role), breaker.acquireRead(request)) };
  const coordinator = options.wrap === undefined ? recording : options.wrap(recording);
  const seams: Seams = { policy: communityPolicy, audit: communityAudit, coordinator };
  const limiter = createRequestLimiter({ clock: () => clock.now, startSweep: () => () => undefined });

  const held: HeldRead[] = [];
  const data = { started: 0, inFlight: 0, peak: 0 };
  const startedBySource = new Map<string, number>();
  const rig = { mode: 'hold' as Mode };
  const schemaOf = (sourceId: string) => {
    const source = mapping.sources.find((each) => each.id === sourceId);
    if (source === undefined) throw new Error(`no source ${sourceId}`);
    return source;
  };
  const respond = (call: ExecuteCall): Promise<ExecuteOutcome> => {
    if (call.templateId !== ENTITY_LOAD_ID && call.templateId !== EDGE_LOAD_ID) return Promise.resolve({ status: 'rows', rows: [] });
    data.started += 1;
    data.inFlight += 1;
    data.peak = Math.max(data.peak, data.inFlight);
    startedBySource.set(call.sourceId, (startedBySource.get(call.sourceId) ?? 0) + 1);
    const answered = call.templateId === EDGE_LOAD_ID ? EDGE_ROWS : entityRows(NODE);
    const done = (outcome: ExecuteOutcome): ExecuteOutcome => (data.inFlight -= 1, outcome);
    if (rig.mode === 'answer') return Promise.resolve(done(answered));
    if (rig.mode === 'timeout') return Promise.resolve(done({ status: 'timeout' }));
    return new Promise<ExecuteOutcome>((resolve) => {
      const entry: HeldRead = {
        sourceId: call.sourceId,
        traceId: call.traceId,
        answer: () => resolve(done(answered)),
        timeOut: () => resolve(done({ status: 'timeout' })),
        fail: () => resolve(done({ status: 'unavailable', reason: 'unreachable' })),
      };
      held.push(entry);
    });
  };
  const executor = new TestExecutor((call) => withSchema(() => schemaAnswer(onlineIndexesOf(schemaOf(call.sourceId))), respond)(call));
  const parts = testSourceGate(mapping, { executor, seams, clock: () => clock.now });
  const webRoot = makeWebRoot();
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams, limiter, sourceTester: { run: () => Promise.resolve({ sourceId: SOURCE } as never) } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${portOf(app)}`;
  /** A burst of simultaneous connections can overrun a loopback listener's backlog, so the client holds at most 64 sockets open and the rest of a burst queues behind them. */
  const sockets = new Agent({ keepAlive: true, maxSockets: 64 });

  let closed = false;
  const api: Rig = {
    now: () => clock.now,
    slots,
    limiter,
    gate: parts.gate,
    executor,
    get mode() {
      return rig.mode;
    },
    set mode(value: Mode) {
      rig.mode = value;
    },
    held,
    data,
    roles,
    startedAt: (sourceId) => startedBySource.get(sourceId) ?? 0,
    http: (sourceId = SOURCE, route = 'entity') =>
      new Promise<HttpAnswer>((resolve, reject) => {
        const call = httpRequest(`${base}${route === 'edge' ? edgePathOf(sourceId) : route === 'link' ? linkPathOf(sourceId) : `/v1/entities/${sourceId}/node_a/H-1`}`, { agent: sockets }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const retryAfter = response.headers['retry-after'];
            resolve({ status: response.statusCode ?? 0, body: parsedBody(Buffer.concat(chunks).toString('utf8')), retryAfter: typeof retryAfter === 'string' ? retryAfter : null });
          });
        });
        call.on('error', reject);
        call.end();
      }),
    get: (path) =>
      new Promise<number>((resolve, reject) => {
        const call = httpRequest(`${base}${path}`, { agent: sockets }, (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode ?? 0));
        });
        call.on('error', reject);
        call.end();
      }),
    asPerson: (person, sourceId = SOURCE, signal) => parts.gate.run(gateRequest({ ...(signal === undefined ? {} : { signal }), principal: person, sourceId, templateId: ENTITY_LOAD_ID, params: { entityType: 'node_a', stableId: 'H-1' }, limit: 1, traceId: `tr-${person.id}` })),
    advance: async (ms) => {
      const target = clock.now + ms;
      await flush();
      for (let due = next(target); due !== undefined; due = next(target)) {
        clock.now = Math.max(clock.now, due.at);
        due.live = false;
        due.run();
        await flush();
      }
      clock.now = target;
      await flush();
    },
    settle: () => flush(),
    until: async (check, what) => {
      // a ceiling for loopback I/O to arrive, not a time any case depends on: the loop ends the moment the state holds
      for (let turn = 0; turn < 10_000 && !check(); turn += 1) await new Promise<void>((resolve) => setTimeout(resolve, 1));
      if (!check()) throw new Error(`never held: ${what}`);
      await flush();
    },
    personHolds: (person = LOCAL_PRINCIPAL, sourceId = SOURCE) => slots.inspect().users.get(JSON.stringify([sourceId, person.id])) ?? { held: 0, waiting: 0 },
    close: async () => {
      if (closed) return;
      closed = true;
      sockets.destroy();
      app.server.closeAllConnections();
      await app.close();
      rmSync(webRoot, { recursive: true, force: true });
    },
  };
  return api;
}

/** Ends every read still held or yet to come, so that no request is left waiting at the end of a case. */
export async function finishAll(rig: Rig, pending: readonly Promise<unknown>[]): Promise<void> {
  rig.mode = 'answer';
  let settled = false;
  void Promise.allSettled(pending).then(() => void (settled = true));
  await rig.until(() => {
    for (const entry of rig.held.splice(0)) entry.answer();
    return settled;
  }, 'every pending request ended');
}

/** What a case leaves behind: a slot held or waited for, or a read still held at the source. */
export function expectNothingLeft(rig: Rig): void {
  expect(rig.slots.inspect().users.size).toBe(0);
  expect(rig.slots.inspect().sources.size).toBe(0);
  expect(rig.held).toEqual([]);
}
