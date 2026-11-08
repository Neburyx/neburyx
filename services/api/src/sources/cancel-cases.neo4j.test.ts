import neo4j, { type Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecuteCall } from '../gate/executor.js';
import { executeRead, type ExecuteDeps } from '../gate/execute.js';
import { RequestCancelled } from '../errors.js';
import type { Rendered } from '../gate/render.js';
import { DEFAULT_BUDGETS } from '../gate/budgets.js';
import type { GateContext, Template } from '../gate/types.js';
import { createReadSlots } from '../seams/read-slots.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, runAll, seedItems, SLOW_READ, sourceFor, startNeo4j, transactionIsListed, waitUntilNotListed, type RunningNeo4j } from '../testing/neo4j-server.js';
import { AdapterError } from './errors.js';
import { createNeo4jExecutor, type Neo4jExecutor } from './executor.js';

const TIMEOUT_MS = 10_000;
const CONCURRENT = 4;
let server: RunningNeo4j;
let executor: Neo4jExecutor;
let readerDriver: Driver;
let writerDriver: Driver;
let sequence = 0;

const callFor = (cypher: string, overrides: Partial<ExecuteCall> = {}): ExecuteCall => ({
  sourceId: 'graph',
  templateId: 'test-read',
  templateVersion: '1',
  cypher,
  parameters: {},
  accessMode: 'READ',
  timeoutMs: TIMEOUT_MS,
  rowLimit: 5,
  deadlineAt: Date.now() + 60_000,
  traceId: `trace-case-${++sequence}-${Date.now()}`,
  ...overrides,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  server = await startNeo4j();
  await seedItems(server);
  executor = createNeo4jExecutor({
    sources: [sourceFor(server, { budgets: { user_concurrency: CONCURRENT, source_concurrency: CONCURRENT } })],
    env: envFor(server),
    logger: { warn: () => undefined },
  });
  readerDriver = neo4j.driver(server.boltUri, neo4j.auth.basic(server.reader.user, server.reader.password));
  writerDriver = neo4j.driver(server.boltUri, neo4j.auth.basic(server.user, server.password));
});

afterAll(async () => {
  await runAll([() => executor?.close(), () => readerDriver?.close(), () => writerDriver?.close(), () => server?.stop()]);
});

describe('a login that can only read, on its own running read', () => {
  it('is told by the server whether it may terminate it; the answer is recorded, and the product never relies on it', async ({ annotate }) => {
    const call = callFor(SLOW_READ);
    const reading = executor.execute(call);
    const session = readerDriver.session({ database: server.database });
    let outcome = 'not attempted';
    try {
      let id: string | undefined;
      for (let look = 0; look < 80 && id === undefined; look += 1) {
        const listed = await session.run('SHOW TRANSACTIONS YIELD transactionId, metaData WHERE metaData.traceId = $traceId RETURN transactionId AS id', { traceId: call.traceId });
        id = listed.records[0]?.get('id') as string | undefined;
        if (id === undefined) await sleep(25);
      }
      if (id === undefined) outcome = 'its own transaction was not listed to the read-only login';
      else {
        try {
          await session.run('TERMINATE TRANSACTION $id YIELD message RETURN message', { id });
          outcome = 'permitted: the read-only login terminated its own read';
        } catch (error) {
          outcome = `refused: ${(error as { code?: string }).code ?? 'unknown code'}`;
        }
      }
    } finally {
      await session.close();
    }
    const line = `a read-only login on Neo4j ${server.version} terminating its own running read: ${outcome}`;
    process.stdout.write(`${line}\n`);
    await annotate(line);
    // whichever it was, the read ends (terminated by the server or by the timeout) and its transaction leaves the list
    const ended = await reading.then(
      (result) => result.status,
      (error: unknown) => (error instanceof AdapterError ? error.code : 'other failure'),
    );
    process.stdout.write(`the adapter's end of that read: ${ended}\n`);
    expect(['rows', 'unavailable', 'timeout', 'READ_FAILED']).toContain(ended);
    expect(await waitUntilNotListed(server, call.traceId, TIMEOUT_MS + 5000)).toBe(true);
  });
});

describe('a write sent in a read-access session', () => {
  it('is refused by the server, even for a login that may write, and nothing is written', async () => {
    const session = writerDriver.session({ database: server.database, defaultAccessMode: neo4j.session.READ });
    let code: string | undefined;
    try {
      const transaction = await session.beginTransaction();
      try {
        await transaction.run('CREATE (:ShouldNotExist {n: 1})');
      } finally {
        await transaction.rollback().catch(() => undefined);
      }
    } catch (error) {
      code = (error as { code?: string }).code;
    } finally {
      await session.close();
    }
    process.stdout.write(`a write in a read-access session on Neo4j ${server.version}: refused with ${code ?? 'no error'}\n`);
    expect(code).toBeDefined();
    const check = server.admin.session({ database: server.database });
    try {
      const result = await check.run('MATCH (n:ShouldNotExist) RETURN count(n) AS found');
      expect(neo4j.integer.toNumber(result.records[0]?.get('found'))).toBe(0);
    } finally {
      await check.close();
    }
  });

  it('is refused through the adapter too, with a login that may write, and nothing is written', async () => {
    const writer = createNeo4jExecutor({ sources: [sourceFor(server)], env: envFor(server, server), logger: { warn: () => undefined } });
    try {
      await expect(writer.execute(callFor('CREATE (:ShouldNotExist {n: 2}) RETURN 1 AS one'))).rejects.toBeInstanceOf(AdapterError);
    } finally {
      await writer.close();
    }
    const check = server.admin.session({ database: server.database });
    try {
      const result = await check.run('MATCH (n:ShouldNotExist) RETURN count(n) AS found');
      expect(neo4j.integer.toNumber(result.records[0]?.get('found'))).toBe(0);
    } finally {
      await check.close();
    }
  });
});

describe('many reads cancelled together at the source limit', () => {
  it('leaves no transaction on the server, no slot held and no session open, and the source serves the next read', async () => {
    const slots = createReadSlots();
    const deps: ExecuteDeps = { coordinator: slots, executor, clock: Date.now, logger: { warn: () => undefined } };
    const base = { ...gateRequest(), principal: LOCAL_PRINCIPAL };
    const template = { id: 'test-read', version: '1', integerParameters: [] } as unknown as Template;
    const controller = new AbortController();
    const traceIds: string[] = [];
    const reads = Array.from({ length: CONCURRENT }, (_, index) => {
      const traceId = `trace-limit-${index}-${Date.now()}`;
      traceIds.push(traceId);
      const context = {
        traceId,
        principal: base.principal,
        system: false,
        sourceId: 'graph',
        budgets: { ...DEFAULT_BUDGETS, userConcurrency: CONCURRENT, sourceConcurrency: CONCURRENT, timeoutMs: TIMEOUT_MS, requestTimeoutMs: 60_000 },
        deadlineAt: Date.now() + 60_000,
        signal: controller.signal,
      } as unknown as GateContext;
      const rendered: Rendered = { cypher: SLOW_READ, parameters: {} };
      return executeRead(deps, context, template, rendered, 5).then(
        () => 'finished' as const,
        (error: unknown) => (error instanceof RequestCancelled ? ('cancelled' as const) : ('failed' as const)),
      );
    });
    for (let look = 0; look < 200; look += 1) {
      const listed = await Promise.all(traceIds.map((id) => transactionIsListed(server, id)));
      if (listed.every(Boolean)) break;
      await sleep(25);
    }
    expect(slots.inspect().sources.get('graph')).toEqual({ held: CONCURRENT, waiting: 0 });
    controller.abort();
    expect(await Promise.all(reads)).toEqual(Array(CONCURRENT).fill('cancelled'));
    for (const traceId of traceIds) expect(await waitUntilNotListed(server, traceId, TIMEOUT_MS)).toBe(true);
    for (let look = 0; look < 80 && slots.inspect().sources.size > 0; look += 1) await sleep(25);
    expect(slots.inspect().sources.size).toBe(0);
    expect(slots.inspect().users.size).toBe(0);
    expect(await executor.execute(callFor('RETURN 1 AS one'))).toMatchObject({ status: 'rows' });
  });
});
