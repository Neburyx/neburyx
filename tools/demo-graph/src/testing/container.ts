import { randomUUID } from 'node:crypto';
import { Neo4jContainer } from '@testcontainers/neo4j';
import neo4j, { type Driver } from 'neo4j-driver';

export const DEFAULT_NEO4J_IMAGE = 'neo4j:5.26';
const STARTUP_LIMIT_MS = 240_000;
/**
 * testcontainers 12.2.1 waits a fixed 30 s for the host port to be bound and offers no setting for it, so
 * `withStartupTimeout` cannot cover that wait. Docker here binds a port in about 0.15 s, so a timeout is a rare
 * stall of the Docker daemon and a new attempt succeeds.
 */
export const START_ATTEMPTS = 3;
const PORT_BOUND_TIMEOUT = /Timed out after \d+ms while waiting for container ports to be bound/;

/** Starts again only when the port-bound wait timed out, up to `attempts` in all; every other error is thrown at once. */
export async function startWithRetry<T>(start: () => Promise<T>, attempts = START_ATTEMPTS): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await start();
    } catch (error) {
      if (attempt >= attempts || !(error instanceof Error) || !PORT_BOUND_TIMEOUT.test(error.message)) throw error;
    }
  }
}

export interface RunningNeo4j {
  readonly image: string;
  readonly boltUri: string;
  readonly user: string;
  readonly password: string;
  readonly admin: Driver;
  stop(): Promise<void>;
}

export function imageFrom(env: Readonly<Record<string, string | undefined>>): string {
  const image = env['NEBURYX_NEO4J_IMAGE'];
  return image === undefined || image === '' ? DEFAULT_NEO4J_IMAGE : image;
}

export async function startNeo4j(image = imageFrom(process.env)): Promise<RunningNeo4j> {
  const password = randomUUID();
  let started;
  try {
    started = await startWithRetry(() => new Neo4jContainer(image).withPassword(password).withStartupTimeout(STARTUP_LIMIT_MS).start());
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
      const failures: unknown[] = [];
      for (const step of [() => admin.close(), () => started.stop()]) {
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
  const session = server.admin.session();
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
