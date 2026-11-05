import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecuteCall } from '../gate/executor.js';
import { createNeo4jExecutor, type Neo4jExecutor } from './executor.js';
import { forwardTo, type Forwarder } from '@neburyx/test-neo4j';
import { envFor, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';

let server: RunningNeo4j;
let executor: Neo4jExecutor;
let forwarder: Forwarder;

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
  forwarder = await forwardTo(server.boltUri);
  executor = createNeo4jExecutor({ sources: [sourceFor(server, { uri: forwarder.uri })], env: envFor(server), logger: { warn: () => undefined } });
});

afterAll(async () => {
  await runAll([() => executor?.close(), () => forwarder?.close(), () => server?.stop()]);
});

describe('a source whose server has stopped answering (its port closed)', () => {
  it('answers unavailable', async () => {
    expect(await executor.execute(call())).toMatchObject({ status: 'rows' });
    await forwarder.stop();
    expect(await executor.execute(call())).toEqual({ status: 'unavailable', reason: 'unreachable' });
  });
});
