import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecuteCall } from '../gate/executor.js';
import { createNeo4jExecutor, type Neo4jExecutor } from './executor.js';
import { envFor, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-container.js';

let server: RunningNeo4j;
let executor: Neo4jExecutor;

function call(): ExecuteCall {
  return {
    sourceId: 'graph',
    templateId: 'test-read',
    templateVersion: '1',
    cypher: 'RETURN 1 AS one',
    parameters: {},
    accessMode: 'READ',
    timeoutMs: 10_000,
    rowLimit: 5,
    deadlineAt: Date.now() + 60_000,
    traceId: 'trace-stopped',
  };
}

beforeAll(async () => {
  server = await startNeo4j();
  executor = createNeo4jExecutor({ sources: [sourceFor(server)], env: envFor(server), logger: { warn: () => undefined } });
});

afterAll(async () => {
  await runAll([() => executor?.close(), () => server?.stop()]);
});

describe('a source whose server has stopped', () => {
  it('answers unavailable', async () => {
    expect(await executor.execute(call())).toMatchObject({ status: 'rows' });
    await server.stop();
    expect(await executor.execute(call())).toEqual({ status: 'unavailable', reason: 'unreachable' });
  });
});
