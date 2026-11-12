import { randomUUID } from 'node:crypto';
import { Neo4jContainer, type StartedNeo4jContainer } from '@testcontainers/neo4j';
import { startWithRetry } from '@neburyx/test-containers';
import neo4j from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecuteCall } from '../gate/executor.js';
import { baseSource, firstSource, load } from '../testing/mapping.js';
import { createNeo4jExecutor } from './executor.js';

const IMAGE = 'neo4j:5.26';
const STARTUP_LIMIT_MS = 240_000;
const USER = 'neo4j';
const RATE_LIMIT = 'Neo.ClientError.Security.AuthenticationRateLimit';
const UNAUTHORIZED = 'Neo.ClientError.Security.Unauthorized';
const POLL_MS = 250;
/** Room for the polling step and the round trip of one sign-in. */
const MARGIN_MS = 2000;
const OLD_PASSWORD = randomUUID();
const NEW_PASSWORD = randomUUID();

let container: StartedNeo4jContainer;
let lockTimeMs = 0;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The server's answer to one sign-in: `accepted`, or the status code that refused it. */
async function signIn(password: string): Promise<string> {
  const driver = neo4j.driver(container.getBoltUri(), neo4j.auth.basic(USER, password));
  try {
    await driver.getServerInfo();
    return 'accepted';
  } catch (error) {
    const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined;
    return typeof code === 'string' ? code : 'unknown';
  } finally {
    await driver.close();
  }
}

/** Signs in with the old password until the server answers with the lock; returns the time of the sign-in that was refused for it. */
async function lockWithOldPassword(): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const answer = await signIn(OLD_PASSWORD);
    if (answer === RATE_LIMIT) return Date.now();
    expect(answer).toBe(UNAUTHORIZED);
  }
  throw new Error('the server never locked the login');
}

/** Polls the new password until it is accepted; returns the time it was. */
async function acceptedAt(): Promise<number> {
  for (;;) {
    if ((await signIn(NEW_PASSWORD)) === 'accepted') return Date.now();
    await wait(POLL_MS);
  }
}

async function resetPassword(): Promise<void> {
  const admin = neo4j.driver(container.getBoltUri(), neo4j.auth.basic(USER, NEW_PASSWORD));
  try {
    const session = admin.session({ database: 'system' });
    try {
      await session.run('ALTER CURRENT USER SET PASSWORD FROM $new TO $old', { new: NEW_PASSWORD, old: OLD_PASSWORD });
    } finally {
      await session.close();
    }
  } finally {
    await admin.close();
  }
}

function durationMs(text: string): number {
  const parsed = /^(\d+)(ms|s|m)$/.exec(text);
  if (parsed?.[1] === undefined || parsed[2] === undefined) throw new Error(`the lock time is not a duration: ${text}`);
  return Number(parsed[1]) * { ms: 1, s: 1000, m: 60_000 }[parsed[2] as 'ms' | 's' | 'm'];
}

async function readLockTime(): Promise<number> {
  const admin = neo4j.driver(container.getBoltUri(), neo4j.auth.basic(USER, OLD_PASSWORD));
  try {
    const result = await admin.executeQuery("CALL dbms.listConfig('dbms.security.auth_lock_time') YIELD value RETURN value", {}, { database: 'system' });
    return durationMs(String(result.records[0]?.get('value')));
  } finally {
    await admin.close();
  }
}

/** The password of the login is changed through the test's own admin session, never through the gate. */
async function changePassword(): Promise<void> {
  const admin = neo4j.driver(container.getBoltUri(), neo4j.auth.basic(USER, OLD_PASSWORD));
  try {
    const session = admin.session({ database: 'system' });
    try {
      await session.run('ALTER CURRENT USER SET PASSWORD FROM $old TO $new', { old: OLD_PASSWORD, new: NEW_PASSWORD });
    } finally {
      await session.close();
    }
  } finally {
    await admin.close();
  }
}

beforeAll(async () => {
  container = await startWithRetry((labels) => new Neo4jContainer(IMAGE).withPassword(OLD_PASSWORD).withStartupTimeout(STARTUP_LIMIT_MS).withLabels(labels).start());
  lockTimeMs = await readLockTime();
  await changePassword();
}, STARTUP_LIMIT_MS + 60_000);

afterAll(async () => {
  await container?.stop();
});

describe('the failed-login lock of a Neo4j server at its default settings', () => {
  it('refuses the new password while the lock holds, and accepts it once the lock time has passed', async () => {
    expect(lockTimeMs).toBeGreaterThan(0);
    const lockedAt = await lockWithOldPassword();
    expect(await signIn(NEW_PASSWORD)).toBe(RATE_LIMIT);
    const accepted = await acceptedAt();
    expect(accepted - lockedAt).toBeLessThanOrEqual(lockTimeMs + MARGIN_MS);
    expect(accepted - lockedAt).toBeGreaterThanOrEqual(lockTimeMs - MARGIN_MS);
    await resetPassword();
    await changePassword();
  });

  it('is not re-armed by an old-password sign-in made during the lock: the new password is refused until the original end of the lock and accepted by it', async () => {
    const lockedAt = await lockWithOldPassword();
    await wait(POLL_MS * 4);
    expect(await signIn(OLD_PASSWORD)).toBe(RATE_LIMIT);
    expect(await signIn(NEW_PASSWORD)).toBe(RATE_LIMIT);
    const accepted = await acceptedAt();
    expect(accepted - lockedAt).toBeGreaterThanOrEqual(lockTimeMs - MARGIN_MS);
    expect(accepted - lockedAt).toBeLessThanOrEqual(lockTimeMs + MARGIN_MS);
    await resetPassword();
    await changePassword();
  });

  it('is not re-armed by a stream of refused sign-ins with the right password through the whole lock, as repeated checks of a locked source make: it is accepted by the original end of the lock', async () => {
    const lockedAt = await lockWithOldPassword();
    let refused = 0;
    let accepted: number | undefined;
    while (accepted === undefined && Date.now() - lockedAt < lockTimeMs + MARGIN_MS * 2) {
      if ((await signIn(NEW_PASSWORD)) === 'accepted') accepted = Date.now();
      else refused += 1;
      await wait(POLL_MS);
    }
    expect(refused).toBeGreaterThan(3);
    expect(accepted).toBeDefined();
    expect((accepted ?? Number.POSITIVE_INFINITY) - lockedAt).toBeLessThanOrEqual(lockTimeMs + MARGIN_MS);
    await resetPassword();
    await changePassword();
  });

  it('locks again at once on one failed sign-in made right after the lock ended, and then accepts the new password a lock time later', async () => {
    const lockedAt = await lockWithOldPassword();
    await wait(lockedAt + lockTimeMs + POLL_MS - Date.now());
    const failedAt = Date.now();
    expect(await signIn(OLD_PASSWORD)).toBe(UNAUTHORIZED);
    expect(await signIn(NEW_PASSWORD)).toBe(RATE_LIMIT);
    const accepted = await acceptedAt();
    expect(accepted - failedAt).toBeGreaterThanOrEqual(lockTimeMs - MARGIN_MS);
    expect(accepted - failedAt).toBeLessThanOrEqual(lockTimeMs + MARGIN_MS);
    await resetPassword();
    await changePassword();
  });

  it('refuses a read through the executor with the lock code in the log, and answers rows with a new executor once the lock time has passed since the last old-password sign-in', async () => {
    const lockedAt = await lockWithOldPassword();
    const logs: { fields: Record<string, unknown> }[] = [];
    const source = firstSource(load(baseSource({ id: 'graph', uri: container.getBoltUri(), database: 'neo4j', auth: { kind: 'basic', username_env: 'LOCK_USER', password_env: 'LOCK_PASSWORD' } })));
    const call = (): ExecuteCall => ({ sourceId: 'graph', templateId: 'test-read', templateVersion: '1', cypher: 'RETURN 1 AS one', parameters: {}, accessMode: 'READ', timeoutMs: 10_000, rowLimit: 5, deadlineAt: Date.now() + 60_000, traceId: 'trace-lock' });
    const env = { LOCK_USER: USER, LOCK_PASSWORD: OLD_PASSWORD };
    const old = createNeo4jExecutor({ sources: [source], env, logger: { warn: (fields) => void logs.push({ fields: { ...fields } }) } });
    expect(await old.execute(call())).toEqual({ status: 'unavailable', reason: 'authentication' });
    await old.close();
    expect(logs.map((line) => line.fields)).toContainEqual({ event: 'source.sign_in_refused', sourceId: 'graph', serverCode: expect.stringMatching(new RegExp(`^(${RATE_LIMIT}|${UNAUTHORIZED})$`)) });
    const lastOldAt = Date.now();
    const fresh = createNeo4jExecutor({ sources: [source], env: { ...env, LOCK_PASSWORD: NEW_PASSWORD }, logger: { warn: (fields) => void logs.push({ fields: { ...fields } }) } });
    let outcome = await fresh.execute(call());
    while (outcome.status !== 'rows' && Date.now() - lastOldAt < lockTimeMs + MARGIN_MS) {
      expect(logs.at(-1)?.fields).toEqual({ event: 'source.sign_in_refused', sourceId: 'graph', serverCode: RATE_LIMIT });
      await wait(POLL_MS);
      outcome = await fresh.execute(call());
    }
    await fresh.close();
    expect(outcome.status).toBe('rows');
    expect(Date.now() - lockedAt).toBeLessThanOrEqual(lockTimeMs + MARGIN_MS * 2);
  });
});
