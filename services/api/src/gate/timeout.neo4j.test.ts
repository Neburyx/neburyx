import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { communitySeams } from '../seams/community-seams.js';
import type { Coordinator, ReadLease } from '../seams/seams.js';
import { createNeo4jExecutor, type Neo4jExecutor } from '../sources/executor.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { gateRequest, testCatalog, testTemplate } from '../testing/gate.js';
import { envFor, NEO4J_ENV_PASSWORD, NEO4J_ENV_USER, pollUntil, runAll, seedItems, SLOW_READ, startNeo4j, transactionIsListed, type RunningNeo4j } from '../testing/neo4j-server.js';
import { assembleGate } from './assemble.js';
import type { Gate } from './types.js';

const BUDGET_MS = 1000;
const CEILING_MS = 2000;
const POLL_MS = 25;

let server: RunningNeo4j;
let executor: Neo4jExecutor;
let gate: Gate;
const leases = { taken: 0, released: 0 };

const asRow = (rows: readonly Record<string, unknown>[]) => rows.map((row) => ({ found: String(row['found']) }));
const catalog = testCatalog([
  testTemplate({ id: 'slow-read', cypher: SLOW_READ, paramsSchema: z.strictObject({}), normalize: asRow }),
  testTemplate({ id: 'quick-read', cypher: 'MATCH (i:Item) WHERE i.n < 5 RETURN count(i) AS found', paramsSchema: z.strictObject({}), normalize: asRow }),
]);

beforeAll(async () => {
  server = await startNeo4j();
  await seedItems(server);
  const mapping = mappingOf(
    sourceWith('alpha', {
      uri: server.boltUri,
      database: server.database,
      auth: { kind: 'basic', username_env: NEO4J_ENV_USER, password_env: NEO4J_ENV_PASSWORD },
      budgets: { timeout_ms: BUDGET_MS },
    }),
  );
  executor = createNeo4jExecutor({ sources: mapping.sources, env: envFor(server), logger: { warn: () => undefined } });
  const seams = communitySeams();
  const coordinator: Coordinator = {
    async acquireRead(request) {
      const admission = await seams.coordinator.acquireRead(request);
      if (admission.status !== 'granted') return admission;
      leases.taken += 1;
      const lease: ReadLease = {
        release: () => {
          leases.released += 1;
          return admission.lease.release();
        },
      };
      return { status: 'granted', lease };
    },
  };
  ({ gate } = assembleGate({ mapping, seams: { policy: seams.policy, coordinator, audit: seams.audit }, executor, logger: { warn: () => undefined }, catalog }));
});

afterAll(async () => {
  await runAll([() => executor?.close(), () => server?.stop()]);
});

describe('a read forced past a 1 s budget, through the gate and the real adapter', () => {
  it('answers QUERY_TIMEOUT naming the budget, within the budget plus a margin, and the server lists the transaction no more', async ({ annotate }) => {
    const traceId = `tr-timeout-${Date.now()}`;
    const started = Date.now();
    const answer: Promise<unknown> = gate.run(gateRequest({ sourceId: 'alpha', templateId: 'slow-read', params: {}, limit: 1, traceId })).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(await pollUntil(() => transactionIsListed(server, traceId), BUDGET_MS - 200, POLL_MS)).toBe(true);
    const error = await answer;
    const elapsed = Date.now() - started;
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'QUERY_TIMEOUT', details: { timeoutMs: BUDGET_MS } });
    expect(elapsed).toBeGreaterThanOrEqual(BUDGET_MS);
    expect(elapsed).toBeLessThan(CEILING_MS);
    const answered = Date.now();
    expect(await pollUntil(async () => !(await transactionIsListed(server, traceId)), BUDGET_MS, POLL_MS)).toBe(true);
    const gone = Date.now() - answered;
    await annotate(`observed: answered ${elapsed} ms after the call for a ${BUDGET_MS} ms budget; the transaction was first seen gone ${gone} ms after the answer (polled every ${POLL_MS} ms)`);
    expect(leases.taken).toBe(1);
    await expect.poll(() => leases.released).toBe(1);
  });

  it('serves the next read of the source', async () => {
    const page = await gate.run(gateRequest({ sourceId: 'alpha', templateId: 'quick-read', params: {}, limit: 1 }));
    expect(page.items).toHaveLength(1);
  });
});
