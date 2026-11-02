import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecuteCall } from '../gate/executor.js';
import { createNeo4jExecutor, type Neo4jExecutor } from './executor.js';
import { envFor, NEO4J_ENV_PASSWORD, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-container.js';

let server: RunningNeo4j;
let executor: Neo4jExecutor;
let env: Record<string, string>;

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
    traceId: 'trace-credentials',
  };
}

beforeAll(async () => {
  server = await startNeo4j();
  env = envFor(server);
  executor = createNeo4jExecutor({ sources: [sourceFor(server)], env, logger: { warn: () => undefined } });
});

afterAll(async () => {
  await runAll([() => executor?.close(), () => server?.stop()]);
});

describe('a source with a wrong password', () => {
  it('answers unavailable, and rows once the password is corrected', async () => {
    const correct = env[NEO4J_ENV_PASSWORD] ?? '';
    env[NEO4J_ENV_PASSWORD] = 'a wrong password';
    expect(await executor.execute(call())).toEqual({ status: 'unavailable' });
    env[NEO4J_ENV_PASSWORD] = correct;
    expect(await executor.execute(call())).toMatchObject({ status: 'rows' });
  });
});
