import { randomUUID } from 'node:crypto';
import { dockerOk } from '../image/docker.js';
import { Neo4jContainer } from '@testcontainers/neo4j';
import neo4j, { type Driver } from 'neo4j-driver';
import type { SourceModel } from '../mapping/model.js';
import { baseSource, firstSource, load, type Json } from './mapping.js';

export const DEFAULT_NEO4J_IMAGE = 'neo4j:5.26';
const STARTUP_LIMIT_MS = 240_000;

export function neo4jImageFrom(env: Readonly<Record<string, string | undefined>>): string {
  const image = env['NEBURYX_NEO4J_IMAGE'];
  return image === undefined || image === '' ? DEFAULT_NEO4J_IMAGE : image;
}

export interface RunningNeo4j {
  readonly image: string;
  readonly boltUri: string;
  readonly user: string;
  readonly password: string;
  readonly admin: Driver;
  stop(): Promise<void>;
  /** Stops the container without removing it. Only for a server started with a fixed host port. */
  halt(): Promise<void>;
  /** Starts a halted container again at the same address and returns once the server answers. */
  resume(): Promise<void>;
}

export interface StartNeo4jOptions {
  /** Binds the Bolt port to this host port, so that the address stays the same when the container is halted and resumed. */
  readonly hostPort?: number;
  /** Extra settings of the server, as environment variables of the image (`NEO4J_server_databases_default__to__read__only`). */
  readonly environment?: Readonly<Record<string, string>>;
}

export async function startNeo4j(image = neo4jImageFrom(process.env), options: StartNeo4jOptions = {}): Promise<RunningNeo4j> {
  const password = randomUUID();
  let started;
  try {
    const container = new Neo4jContainer(image).withPassword(password).withStartupTimeout(STARTUP_LIMIT_MS);
    if (options.hostPort !== undefined) container.withExposedPorts({ container: 7687, host: options.hostPort });
    if (options.environment !== undefined) container.withEnvironment({ ...options.environment });
    started = await container.start();
  } catch (error) {
    throw new Error(`could not start the Neo4j image ${image}: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  const admin = neo4j.driver(started.getBoltUri(), neo4j.auth.basic(started.getUsername(), password));
  let stopped = false;
  return {
    image,
    boltUri: started.getBoltUri(),
    user: started.getUsername(),
    password,
    admin,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await runAll([() => admin.close(), () => started.stop()]);
    },
    halt: async () => {
      await dockerOk(['stop', started.getId()]);
    },
    resume: async () => {
      await dockerOk(['start', started.getId()]);
      const answered = await pollUntil(() => admin.getServerInfo().then(() => true, () => false), STARTUP_LIMIT_MS, 1000);
      if (!answered) throw new Error('the Neo4j server did not answer after it was started again');
      // the server answers a query of its own once its database is online, which is the signal that a client can read
      const reads = await pollUntil(async () => {
        const session = admin.session({ database: 'neo4j' });
        try {
          await session.run('RETURN 1');
          return true;
        } catch {
          return false;
        } finally {
          await session.close();
        }
      }, STARTUP_LIMIT_MS, 500);
      if (!reads) throw new Error('the Neo4j database did not answer a query after it was started again');
    },
  };
}

export const NEO4J_ENV_USER = 'NEO4J_TEST_USER';
export const NEO4J_ENV_PASSWORD = 'NEO4J_TEST_PASSWORD';

export function envFor(server: RunningNeo4j): Record<string, string> {
  return { [NEO4J_ENV_USER]: server.user, [NEO4J_ENV_PASSWORD]: server.password };
}

export function sourceFor(server: RunningNeo4j, overrides: Json = {}): SourceModel {
  return firstSource(
    load(
      baseSource({
        id: 'graph',
        uri: server.boltUri,
        database: 'neo4j',
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

export async function runAdmin(server: RunningNeo4j, cypher: string, parameters: Record<string, unknown> = {}, database = 'neo4j'): Promise<void> {
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
    const result = await session.run('SHOW TRANSACTIONS YIELD metaData WHERE metaData.traceId = $traceId RETURN count(*) AS listed', { traceId });
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
