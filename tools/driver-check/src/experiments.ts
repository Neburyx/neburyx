import { randomUUID } from 'node:crypto';
import type { Backend, Connection } from './backend.js';
import { ExperimentError } from './errors.js';
import { Poller, assertNever, bounded, describeError, settle, sleep, type Settled } from './probe.js';
import { readClose, readTimeout, type CallEnd, type CloseEnd } from './readings.js';
import {
  CLEANUP_LIMIT_MS,
  CLOSE_TIMEOUT_MS,
  NODE_COUNT,
  POLL_MS,
  READ_TIMEOUT_MS,
  RUNNING_WAIT_MS,
  RUN_END_MS,
  SETTLE_LIMIT_MS,
  TAIL_MS,
} from './settings.js';
import type { CloseResult, Findings, QuickResult, Reuse, ServerFacts, TimeoutResult } from './types.js';

const CROSS_PRODUCT = 'MATCH (a:Item), (b:Item), (c:Item) WHERE a.n + b.n + c.n = -1 RETURN count(*) AS found';
const QUICK_READ = 'MATCH (a:Item) WHERE a.n < 5 RETURN count(a) AS found';

async function cleanUp(failures: string[], label: string, close: () => Promise<unknown>): Promise<void> {
  const outcome = await settle(close(), CLEANUP_LIMIT_MS, performance.now());
  if (outcome.kind === 'error') failures.push(`${label}: ${describeError(outcome.error).code}`);
  else if (outcome.kind === 'unsettled') failures.push(`${label}: did not finish within ${CLEANUP_LIMIT_MS} ms`);
}

export async function prepare(backend: Backend, image: string, failures: string[]): Promise<ServerFacts> {
  const connection = backend.connect();
  const session = connection.session('write');
  try {
    const info = await bounded('read the server version', session.run('CALL dbms.components() YIELD versions, edition RETURN versions[0] AS version, edition'));
    await bounded('write the synthetic data', session.write('UNWIND range(1, $count) AS n CREATE (:Item {n: n})', { count: NODE_COUNT }));
    return {
      image,
      serverVersion: String(info.records[0]?.get('version')),
      edition: String(info.records[0]?.get('edition')),
      driverVersion: backend.driverVersion,
    };
  } finally {
    await cleanUp(failures, 'session of the preparation', () => session.close());
    await cleanUp(failures, 'connection of the preparation', () => connection.close());
  }
}

async function reuse(run: () => Promise<unknown>): Promise<Reuse> {
  const outcome = await settle(run(), CLEANUP_LIMIT_MS, performance.now());
  switch (outcome.kind) {
    case 'value':
      return { ok: true };
    case 'unsettled':
      return { ok: false, what: `no answer within ${CLEANUP_LIMIT_MS} ms` };
    case 'error': {
      const { errorClass, code } = describeError(outcome.error);
      return { ok: false, what: `${errorClass} ${code}` };
    }
    default:
      return assertNever(outcome);
  }
}

function endOf(outcome: Settled<number>): CallEnd {
  switch (outcome.kind) {
    case 'value':
      return { kind: 'returned', atMs: outcome.atMs, rows: outcome.value };
    case 'error':
      return { kind: 'raised', atMs: outcome.atMs, ...describeError(outcome.error) };
    case 'unsettled':
      return { kind: 'unsettled', atMs: outcome.atMs };
    default:
      return assertNever(outcome);
  }
}

function closeEndOf(outcome: Settled<unknown>, calledAtMs: number): CloseEnd {
  switch (outcome.kind) {
    case 'value':
      return { kind: 'returned', calledAtMs, atMs: calledAtMs + outcome.atMs };
    case 'error':
      return { kind: 'raised', calledAtMs, atMs: calledAtMs + outcome.atMs, ...describeError(outcome.error) };
    case 'unsettled':
      return { kind: 'unsettled', calledAtMs };
    default:
      return assertNever(outcome);
  }
}

async function rowCount(result: Promise<{ records: readonly unknown[] }>): Promise<number> {
  return (await result).records.length;
}

interface Observed {
  readonly connection: Connection;
  readonly observer: Connection;
  readonly poller: Poller;
  readonly marker: string;
}

function observe(backend: Backend): Observed {
  const marker = randomUUID();
  const observer = backend.connect();
  return { connection: backend.connect(), observer, marker, poller: new Poller(() => observer.list(marker)) };
}

async function release(observed: Observed, label: string, failures: string[], session: { close(): Promise<unknown> }): Promise<void> {
  failures.push(...(await observed.poller.stop()));
  await cleanUp(failures, `session of the ${label}`, () => session.close());
  await cleanUp(failures, `connection of the ${label}`, () => observed.connection.close());
  await cleanUp(failures, `observer of the ${label}`, () => observed.observer.close());
}

export async function runTimeout(backend: Backend, failures: string[]): Promise<TimeoutResult> {
  const observed = observe(backend);
  const { poller, marker } = observed;
  const session = observed.connection.session('read');
  try {
    poller.start();
    await sleep(2 * POLL_MS);
    const tx = await bounded('begin the transaction', session.beginTransaction({ timeout: READ_TIMEOUT_MS, metadata: { check: marker } }));
    const origin = performance.now();
    const end = endOf(await settle(rowCount(tx.run(CROSS_PRODUCT)), SETTLE_LIMIT_MS, origin));
    await sleep(Math.max(0, origin + end.atMs + TAIL_MS + POLL_MS - performance.now()));
    await poller.stop();
    // after the observation window, so closing the original transaction cannot change what was observed
    if (end.kind !== 'raised') await cleanUp(failures, 'transaction of the timeout run', () => tx.close());
    const sessionReuse = await reuse(async () => {
      const next = await session.beginTransaction({ timeout: CLEANUP_LIMIT_MS });
      await next.run('RETURN 1 AS one');
      await next.commit();
    });
    const samples = poller.samples(origin);
    return { end, samples, reading: readTimeout(samples, end, READ_TIMEOUT_MS, TAIL_MS), sessionReuse };
  } finally {
    await release(observed, 'timeout run', failures, session);
  }
}

export async function runQuick(backend: Backend, failures: string[]): Promise<QuickResult> {
  const connection = backend.connect();
  const session = connection.session('read');
  try {
    const tx = await bounded('begin the transaction', session.beginTransaction({ timeout: READ_TIMEOUT_MS }));
    const outcome = await settle(rowCount(tx.run(QUICK_READ)), SETTLE_LIMIT_MS, performance.now());
    if (outcome.kind === 'value') {
      await bounded('commit', tx.commit());
      return { returned: true, rows: outcome.value, elapsedMs: outcome.atMs };
    }
    const what = outcome.kind === 'error' ? describeError(outcome.error).code : `no answer within ${SETTLE_LIMIT_MS} ms`;
    return { returned: false, rows: 0, elapsedMs: outcome.atMs, what };
  } finally {
    await cleanUp(failures, 'session of the quick read', () => session.close());
    await cleanUp(failures, 'connection of the quick read', () => connection.close());
  }
}

export async function runClose(backend: Backend, target: 'transaction' | 'session', failures: string[]): Promise<CloseResult> {
  const observed = observe(backend);
  const { poller, marker } = observed;
  const session = observed.connection.session('read');
  try {
    poller.start();
    await sleep(2 * POLL_MS);
    const tx = await bounded('begin the transaction', session.beginTransaction({ timeout: CLOSE_TIMEOUT_MS, metadata: { check: marker } }));
    const origin = performance.now();
    let callDoneAtMs: number | undefined;
    const pendingCall = settle(rowCount(tx.run(CROSS_PRODUCT)), SETTLE_LIMIT_MS, origin).then((outcome) => {
      callDoneAtMs = outcome.atMs;
      return outcome;
    });
    const waitUntil = performance.now() + RUNNING_WAIT_MS;
    while (!poller.sawRunning() && callDoneAtMs === undefined && performance.now() < waitUntil) await sleep(POLL_MS / 5);
    const calledAtMs = performance.now() - origin;
    const callEndedBeforeClose = callDoneAtMs !== undefined;
    const closing = settle(target === 'transaction' ? tx.close() : session.close(), SETTLE_LIMIT_MS, performance.now());
    const end = endOf(await pendingCall);
    const closeEnd = closeEndOf(await closing, calledAtMs);
    const fresh = observed.connection.session('read');
    const driverReuse = await reuse(() => fresh.run('RETURN 1 AS one'));
    await cleanUp(failures, `fresh session of the ${target} close run`, () => fresh.close());
    await sleep(Math.max(0, origin + RUN_END_MS - performance.now()));
    await poller.stop();
    const samples = poller.samples(origin);
    return { target, end, closeEnd, samples, reading: readClose(samples, calledAtMs, CLOSE_TIMEOUT_MS, callEndedBeforeClose), driverReuse };
  } finally {
    await release(observed, `${target} close run`, failures, session);
  }
}

export async function runAll(backend: Backend, image: string): Promise<Findings> {
  const cleanupFailures: string[] = [];
  try {
    const facts = await prepare(backend, image, cleanupFailures);
    const timeout = await runTimeout(backend, cleanupFailures);
    const quick = await runQuick(backend, cleanupFailures);
    const closes = [await runClose(backend, 'transaction', cleanupFailures), await runClose(backend, 'session', cleanupFailures)];
    return { facts, timeout, quick, closes, cleanupFailures };
  } catch (error) {
    throw new ExperimentError(error, cleanupFailures);
  }
}
