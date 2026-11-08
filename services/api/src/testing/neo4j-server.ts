import { startDevNeo4j, stopAllStarted, type DevNeo4j, type Login } from '@neburyx/test-neo4j';
import neo4j from 'neo4j-driver';
import { afterAll, inject } from 'vitest';
import { checkSeries } from './series.js';
import type { SourceModel } from '../mapping/model.js';
import { baseSource, firstSource, load, type Json } from './mapping.js';

/**
 * The dev server and the database this run made on it (see packages/test-neo4j), with `reader`: a login of this run that can only read that database.
 * A source reads with the reader, as a source does in use, so the report of a test of the source says what it says for a read-only login;
 * `user` and `password` are the dev login, for what writes: a loader, the seeding, the system database.
 */
export type RunningNeo4j = DevNeo4j & { readonly reader: Login };

/** Connects to the dev server (the connection comes from NBX_EE_URI, NBX_EE_USER and NBX_EE_PASSWORD, or the file the test-neo4j README names) and makes a database for the caller. Fails when the connection is not given. */
export const startNeo4j = async (): Promise<RunningNeo4j> => {
  const server = await startDevNeo4j();
  try {
    checkSeries(server.version);
    const reader = await server.createLogin('reader');
    return Object.assign(server, { reader });
  } catch (error) {
    await server.stop().catch(() => undefined);
    throw error;
  }
};

// whatever a hook started and did not stop (a start that failed while another succeeded) is stopped when the file ends
afterAll(async () => {
  await stopAllStarted();
});

declare module 'vitest' {
  export interface ProvidedContext {
    neo4jSeries: string;
  }
}

/** The release series of the server this run connects to (`5.26` or `2026`), read by the global setup and handed to the test files; `5.26` where no setup ran, as in a unit test. */
const provided = (): string => {
  try {
    return inject('neo4jSeries') ?? '5.26';
  } catch {
    // inject throws outside a vitest run with a global setup, as in a tool that imports this module; the default series stands in
    return '5.26';
  }
};
export const NEO4J_SERIES_NUMBER = provided();
export const NEO4J_SERIES = `neo4j:${NEO4J_SERIES_NUMBER}`;

export const NEO4J_ENV_USER = 'NEO4J_TEST_USER';
export const NEO4J_ENV_PASSWORD = 'NEO4J_TEST_PASSWORD';

/** The environment variables a source reads its login from: the dev login, or a login of this run (`server.reader`, or one from `server.createLogin`); by default the reader. */
export function envFor(server: RunningNeo4j, login: Login = server.reader): Record<string, string> {
  return { [NEO4J_ENV_USER]: login.user, [NEO4J_ENV_PASSWORD]: login.password };
}

export function sourceFor(server: RunningNeo4j, overrides: Json = {}): SourceModel {
  return firstSource(
    load(
      baseSource({
        id: 'graph',
        uri: server.boltUri,
        database: server.database,
        auth: { kind: 'basic', username_env: NEO4J_ENV_USER, password_env: NEO4J_ENV_PASSWORD },
        ...overrides,
      }),
    ),
  );
}

/** Attempts every step even when one fails, then reports all failures together. */
export async function runAll(steps: readonly (() => Promise<unknown> | undefined)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'a cleanup step failed');
}

export function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Observes until it answers true or the limit has passed. Every observation is bounded by the time left, none starts
 * after the limit, and an observation that cannot finish in time is an error, not a false answer.
 */
export async function pollUntil(observe: () => Promise<boolean>, limitMs: number, intervalMs = 250): Promise<boolean> {
  const until = Date.now() + limitMs;
  for (;;) {
    if (await bounded(observe(), Math.max(1, until - Date.now()), 'the observation')) return true;
    if (until - Date.now() <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, until - Date.now())));
    if (until - Date.now() <= 0) return false;
  }
}

export async function runAdmin(server: RunningNeo4j, cypher: string, parameters: Record<string, unknown> = {}, database = server.database): Promise<void> {
  const session = server.admin.session({ database });
  try {
    await session.run(cypher, parameters);
  } finally {
    await session.close();
  }
}

export async function transactionIsListed(server: RunningNeo4j, traceId: string): Promise<boolean> {
  const session = server.admin.session({ database: 'system' });
  try {
    // the database of the run too, so that a trace id of another run on the same server never matches
    const result = await session.run('SHOW TRANSACTIONS YIELD metaData, database WHERE metaData.traceId = $traceId AND database = $database RETURN count(*) AS listed', { traceId, database: server.database });
    return neo4j.integer.toNumber(result.records[0]?.get('listed')) > 0;
  } finally {
    await session.close();
  }
}

export async function waitUntilNotListed(server: RunningNeo4j, traceId: string, limitMs: number): Promise<boolean> {
  return await pollUntil(async () => !(await transactionIsListed(server, traceId)), limitMs);
}

export const SLOW_READ = 'MATCH (a:Item), (b:Item), (c:Item) WHERE a.n + b.n + c.n = -1 RETURN count(*) AS found';

export async function seedItems(server: RunningNeo4j, count = 3000): Promise<void> {
  await runAdmin(server, 'UNWIND range(1, $count) AS n CREATE (:Item {n: n})', { count: neo4j.int(count) });
}
