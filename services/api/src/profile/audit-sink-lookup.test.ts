import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { createAuditSink } from '@neburyx/ee-audit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAddressCache, lookupStream } from '../db/lookup.js';

let server: net.Server;
let port = 0;
const sockets = new Set<net.Socket>();

beforeAll(async () => {
  server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the connections of the audit sink', () => {
  it('look the database name up once through the address cache the context gives, when several connections wait for it together', async () => {
    const asked: string[] = [];
    const cache = createAddressCache({
      resolve: async (hostname) => {
        asked.push(hostname);
        await new Promise((resolve) => setTimeout(resolve, 50));
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });
    const mounted = createAuditSink({
      databaseUrl: `postgres://app_user@db.slow.test:${port}/neburyx`,
      poolSize: 3,
      connectionTimeoutMs: 2_000,
      statementTimeoutMs: 1_000,
      queryTimeoutMs: 1_000,
      connectionStream: lookupStream(cache),
      newId: () => '01939999-0000-7000-8000-000000000001',
      onConnectionError: () => undefined,
    });
    const event = { actorId: 'a', actorRole: 'viewer' as const, action: 'graph.expand', result: 'success' as const, traceId: 't' };
    const attempts = await Promise.allSettled([mounted.sink.record(event), mounted.sink.record(event), mounted.sink.record(event)]);
    expect(attempts.map((attempt) => attempt.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(asked).toEqual(['db.slow.test']);
    await mounted.close();
  });
});
