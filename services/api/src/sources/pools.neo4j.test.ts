import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecuteCall } from '../gate/executor.js';
import { createNeo4jExecutor, type Neo4jExecutor } from './executor.js';
import { envFor, pollUntil, runAll, seedItems, SLOW_READ, sourceFor, startNeo4j, transactionIsListed, type RunningNeo4j } from '../testing/neo4j-container.js';

let server: RunningNeo4j;
let executor: Neo4jExecutor;

function call(cypher: string, timeoutMs: number, traceId: string): ExecuteCall {
  return { sourceId: 'graph', templateId: 'test-read', templateVersion: '1', cypher, parameters: {}, accessMode: 'READ', timeoutMs, rowLimit: 5, deadlineAt: Date.now() + 60_000, traceId };
}

beforeAll(async () => {
  server = await startNeo4j();
  await seedItems(server);
  executor = createNeo4jExecutor({
    sources: [sourceFor(server, { budgets: { source_concurrency: 1, queue_wait_ms: 300 } })],
    env: envFor(server),
    logger: { warn: () => undefined },
  });
});

afterAll(async () => {
  await runAll([() => executor?.close(), () => server?.stop()]);
});

describe('a pool that is full', () => {
  it('answers unavailable to a call that waits longer than the queue wait, and does not disturb the call in progress', async () => {
    const first = executor.execute(call(SLOW_READ, 3000, 'pool-first'));
    expect(await pollUntil(() => transactionIsListed(server, 'pool-first'), 30_000)).toBe(true);
    expect(await executor.execute(call('RETURN 1 AS one', 3000, 'pool-second'))).toEqual({ status: 'unavailable', reason: 'pool-full' });
    expect(await first).toEqual({ status: 'timeout' });
    expect(await executor.execute(call('RETURN 1 AS one', 3000, 'pool-third'))).toMatchObject({ status: 'rows' });
  });
});
