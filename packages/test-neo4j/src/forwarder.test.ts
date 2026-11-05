import { createServer, connect, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { forwardTo } from './forwarder.js';
import { stopAllStarted } from './registry.js';

const servers: Server[] = [];

/** Whether this machine can listen on the IPv6 loopback address; a test that needs it is reported as skipped, not passed, when it cannot. */
const ipv6 = await new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once('error', () => resolve(false));
  probe.listen(0, '::1', () => probe.close(() => resolve(true)));
});
afterEach(async () => {
  await stopAllStarted();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function echo(host = '127.0.0.1'): Promise<number> {
  const server = createServer((socket) => socket.pipe(socket));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

const exchange = (port: number, text: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('data', (data) => {
      socket.destroy();
      resolve(String(data));
    });
    socket.once('error', reject);
    socket.once('connect', () => socket.write(text));
  });

const portOf = (uri: string): number => Number(new URL(uri).port);

describe('the forwarder', () => {
  it('forwards a loopback port to the address, refuses connections while stopped, and forwards again once resumed on the same port', async () => {
    const target = await echo();
    const forwarder = await forwardTo(`bolt://127.0.0.1:${target}`);
    expect(forwarder.uri).toMatch(/^bolt:\/\/127\.0\.0\.1:\d+$/);
    expect(await exchange(portOf(forwarder.uri), 'ping')).toBe('ping');
    await forwarder.stop();
    await expect(exchange(portOf(forwarder.uri), 'ping')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await forwarder.resume();
    expect(await exchange(portOf(forwarder.uri), 'pong')).toBe('pong');
    await forwarder.close();
  });

  it('reads a routing address as the direct address of the same server, and keeps the self-signed scheme', async () => {
    const target = await echo();
    expect((await forwardTo(`neo4j://127.0.0.1:${target}`)).uri).toMatch(/^bolt:\/\//);
    expect((await forwardTo(`neo4j+ssc://127.0.0.1:${target}`)).uri).toMatch(/^bolt\+ssc:\/\//);
  });

  it('does not repeat a malformed address in its error', async () => {
    const error: unknown = await forwardTo('bolt://secret-host.example.test:notaport').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify(Object.getOwnPropertyNames(error as object).map((name) => String((error as Record<string, unknown>)[name])))).not.toContain('secret-host');
  });

  it('refuses the addresses whose certificate would be checked against the loopback address, and anything that is not a Neo4j address', async () => {
    await expect(forwardTo('bolt+s://dev.example.test:7687')).rejects.toThrow(/not bolt\+s:/);
    await expect(forwardTo('neo4j+s://dev.example.test:7687')).rejects.toThrow(/not neo4j\+s:/);
    await expect(forwardTo('http://dev.example.test')).rejects.toThrow(/not http:/);
  });

  it.skipIf(!ipv6)('reaches a server by an IPv6 address written with brackets', async () => {
    const target = await echo('::1');
    const forwarder = await forwardTo(`bolt://[::1]:${target}`);
    expect(await exchange(portOf(forwarder.uri), 'six')).toBe('six');
  });

  it('ends the connection of the client when the server end fails, so that nothing hangs', async () => {
    const target = createServer((socket) => socket.destroy());
    servers.push(target);
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const address = target.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const forwarder = await forwardTo(`bolt://127.0.0.1:${address.port}`);
    const closed = new Promise<boolean>((resolve) => {
      const socket = connect(portOf(forwarder.uri), '127.0.0.1');
      socket.on('close', () => resolve(true));
      socket.on('error', () => undefined);
      socket.once('connect', () => socket.write('x'));
      setTimeout(() => resolve(false), 5000);
    });
    expect(await closed).toBe(true);
  }, 15_000);
});
