import { forwardTo, startDevNeo4j, stopAllStarted, type DevNeo4j } from '@neburyx/test-neo4j';
import neo4j from 'neo4j-driver';
import { afterAll } from 'vitest';

// whatever a hook started and did not stop (a start that failed while another succeeded) is stopped when the file ends
afterAll(async () => {
  await stopAllStarted();
});

/**
 * The dev server with a database of this run (see packages/test-neo4j), reached through a forwarder on the loopback interface: the loader loads only to a loopback address or a
 * one-word host name, and the dev server has neither. `boltUri` is the address of the forwarder; `database` is the one the loader and the queries use.
 */
export type RunningNeo4j = DevNeo4j;

export async function startNeo4j(): Promise<RunningNeo4j> {
  const dev = await startDevNeo4j();
  let forwarder;
  try {
    forwarder = await forwardTo(dev.boltUri);
  } catch (error) {
    await dev.stop().catch(() => undefined);
    throw error;
  }
  const reached = forwarder;
  return {
    ...dev,
    boltUri: reached.uri,
    async stop() {
      const failures: unknown[] = [];
      for (const step of [() => reached.close(), () => dev.stop()]) {
        try {
          await step();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'a cleanup step failed');
    },
  };
}

export async function query(server: RunningNeo4j, cypher: string, parameters: Record<string, unknown> = {}): Promise<readonly Record<string, unknown>[]> {
  const session = server.admin.session({ database: server.database });
  try {
    const result = await session.run(cypher, parameters);
    return result.records.map((record) => record.toObject());
  } finally {
    await session.close();
  }
}

export function numberOf(value: unknown): number {
  if (neo4j.isInt(value)) return value.toNumber();
  throw new Error('expected a driver integer');
}
