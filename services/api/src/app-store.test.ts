import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { IdentityStartError } from './identity/errors.js';
import { createAppStore } from './app-store.js';

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(onConnection: (socket: Socket) => void): Promise<string> {
  const server = createServer((socket) => {
    sockets.push(socket);
    onConnection(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `postgres://app:secret@127.0.0.1:${address.port}/neburyx`;
}

async function failure(url: string, timeoutMs: number): Promise<unknown> {
  const errors: number[] = [];
  const store = createAppStore(url, () => errors.push(1), { migrationsDirectory: '.', connectionTimeoutMs: timeoutMs });
  try {
    await store.initialize();
    return undefined;
  } catch (error) {
    return error;
  } finally {
    await store.close();
  }
}

describe('initializing against a server that is not a usable database', () => {
  it('reports the database as unreachable when the server drops the connection during start-up', async () => {
    const url = await listen((socket) => socket.destroy());
    const error = await failure(url, 5000);
    expect(error).toBeInstanceOf(IdentityStartError);
    expect(error).toMatchObject({ kind: 'unreachable' });
  });

  it('reports the database as unreachable when the server never answers within the connection timeout', async () => {
    const url = await listen(() => undefined);
    const error = await failure(url, 200);
    expect(error).toBeInstanceOf(IdentityStartError);
    expect(error).toMatchObject({ kind: 'unreachable' });
  });
});

describe('the readiness limit of the store', () => {
  it('gives the probe pool the connection step derived from the limit that is set', async () => {
    const url = await listen(() => undefined);
    const store = createAppStore(url, () => undefined, { migrationsDirectory: '.', readinessLimitMs: 1500 });
    const started = Date.now();
    const checks = await store.readiness();
    const tookMs = Date.now() - started;
    await store.close();
    expect(checks.database).toBe('unreachable');
    expect(tookMs).toBeGreaterThanOrEqual(900);
    expect(tookMs).toBeLessThan(1400);
  });

  it('waits the limit that is set for a check that does not finish', async () => {
    const url = await listen(() => undefined);
    const store = createAppStore(url, () => undefined, { migrationsDirectory: '.', readinessLimitMs: 500 });
    const started = Date.now();
    await store.readiness();
    const tookMs = Date.now() - started;
    await store.close();
    expect(tookMs).toBeLessThan(900);
  });
});
