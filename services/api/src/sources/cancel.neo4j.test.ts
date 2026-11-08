import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecuteCall } from '../gate/executor.js';
import { describeObservation, observeCancel, type ReadEnd } from '../testing/benchmark/cancel.js';
import { envFor, runAll, seedItems, SLOW_READ, sourceFor, startNeo4j, transactionIsListed, waitUntilNotListed, type RunningNeo4j } from '../testing/neo4j-server.js';
import { createNeo4jExecutor, type Neo4jExecutor } from './executor.js';

const TIMEOUT_MS = 10_000;
let server: RunningNeo4j;
let executor: Neo4jExecutor;
let sequence = 0;

const callFor = (cypher: string, signal: AbortSignal): ExecuteCall => ({
  sourceId: 'graph',
  templateId: 'test-read',
  templateVersion: '1',
  cypher,
  parameters: {},
  accessMode: 'READ',
  timeoutMs: TIMEOUT_MS,
  rowLimit: 5,
  deadlineAt: Date.now() + 60_000,
  traceId: `trace-cancel-${++sequence}-${Date.now()}`,
  signal,
});

/** Aborts a read once the server lists its transaction, and looks until the server no longer lists it. */
async function cancelled(cypher: string) {
  let traceId = '';
  let outcome: Awaited<ReturnType<Neo4jExecutor['execute']>> | undefined;
  const observation = await observeCancel(
    async (signal) => {
      const call = callFor(cypher, signal);
      traceId = call.traceId;
      outcome = await executor.execute(call);
      return outcome.status === 'cancelled' ? ('cancelled' as ReadEnd) : 'other';
    },
    { isListed: () => transactionIsListed(server, traceId), now: () => performance.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    { appearMs: 5000, goneMs: TIMEOUT_MS },
  );
  return { observation, outcome, traceId };
}

beforeAll(async () => {
  server = await startNeo4j();
  await seedItems(server);
  executor = createNeo4jExecutor({ sources: [sourceFor(server)], env: envFor(server), logger: { warn: () => undefined } });
});

afterAll(async () => {
  await runAll([() => executor?.close(), () => server?.stop()]);
});

describe('a read cancelled on the dev Neo4j server', () => {
  it('ends as cancelled and its transaction is gone from the server\'s list before the transaction timeout', async ({ annotate }) => {
    const { observation, outcome } = await cancelled(SLOW_READ);
    const line = describeObservation('a slow read (a cross product of 3,000 nodes)', observation);
    process.stdout.write(`${line}\n`);
    await annotate(line);
    expect(observation.kind).toBe('gone');
    if (observation.kind === 'gone') expect(observation.goneAfterMs).toBeLessThan(TIMEOUT_MS);
    expect(outcome).toEqual({ status: 'cancelled' });
  });

  it('changes nothing for a read aborted after its answer: the rows are the answer, the transaction is never listed again, nothing fails', async () => {
    const controller = new AbortController();
    const call = callFor('RETURN 1 AS one', controller.signal);
    const outcome = await executor.execute(call);
    controller.abort();
    expect(outcome).toMatchObject({ status: 'rows' });
    expect(await waitUntilNotListed(server, call.traceId, TIMEOUT_MS)).toBe(true);
  });

  it('is either a cancel or a read that finished first when a quick read is aborted as soon as it is listed, and never a failure', async () => {
    const { observation, outcome } = await cancelled('RETURN 1 AS one');
    expect(['gone', 'finished-first']).toContain(observation.kind);
    expect(['cancelled', 'rows']).toContain(outcome?.status);
  });

  it('serves the next read on the same source after a cancel', async () => {
    await cancelled(SLOW_READ);
    const controller = new AbortController();
    expect(await executor.execute(callFor('RETURN 1 AS one', controller.signal))).toMatchObject({ status: 'rows' });
  });
});
