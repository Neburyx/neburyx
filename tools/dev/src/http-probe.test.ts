import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeBody, probeStatus } from './http-probe.js';

const servers: Server[] = [];

async function stopServers(): Promise<void> {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  })));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await stopServers();
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<Server> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

const urlOf = (server: Server, path = '/'): string => {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  return `http://127.0.0.1:${address.port}${path}`;
};

describe('a probe of an address', () => {
  it('answers with the status, and with the body when the body is asked for', async () => {
    const server = await serve((_request, response) => response.writeHead(503).end('not yet'));
    expect(await probeStatus(urlOf(server), 2000)).toBe(503);
    expect(await probeBody(urlOf(server), 2000)).toEqual({ status: 503, body: 'not yet' });
  });

  it('answers undefined when nothing listens, when the connection is reset, and when no answer comes in time', async () => {
    const closed = await serve((_request, response) => response.end());
    const closedUrl = urlOf(closed);
    await stopServers();
    expect(await probeStatus(closedUrl, 500)).toBeUndefined();
    const reset = await serve((request) => request.socket.resetAndDestroy());
    expect(await probeStatus(urlOf(reset), 500)).toBeUndefined();
    const silent = await serve(() => undefined);
    expect(await probeStatus(urlOf(silent), 200)).toBeUndefined();
  });

  it('takes the status when the headers arrive, so an answer whose body never comes still counts', async () => {
    const server = await serve((_request, response) => response.writeHead(200).flushHeaders());
    expect(await probeStatus(urlOf(server), 1000)).toBe(200);
    expect(await probeBody(urlOf(server), 300)).toBeUndefined();
  });

  it('gives up on a body that never ends within the time given in all, not within the time between two chunks, and holds no more than a megabyte', async () => {
    let sent = 0;
    const server = await serve((_request, response) => {
      response.writeHead(503);
      const timer = setInterval(() => {
        sent += 1;
        response.write('x'.repeat(100));
      }, 5);
      response.on('close', () => clearInterval(timer));
    });
    const before = Date.now();
    expect(await probeBody(urlOf(server), 400)).toBeUndefined();
    expect(Date.now() - before).toBeLessThan(1500);
    expect(sent).toBeGreaterThan(0);
    const big = await serve((_request, response) => response.writeHead(200).end('y'.repeat((1 << 20) + 1)));
    expect(await probeBody(urlOf(big), 2000)).toBeUndefined();
    expect(await probeStatus(urlOf(big), 2000)).toBe(200);
  });

  it('follows a redirect, as fetch does, to a relative or an absolute address, a few times and no more', async () => {
    const server = await serve((request, response) => {
      if (request.url === '/old') response.writeHead(302, { location: '/healthy' }).end();
      else if (request.url === '/healthy') response.writeHead(200).end('ok');
      else if (request.url === '/loop') response.writeHead(302, { location: '/loop' }).end();
      else if (request.url === '/same') response.writeHead(304, { location: '/healthy' }).end();
      else response.writeHead(404).end();
    });
    expect(await probeStatus(urlOf(server, '/old'), 2000)).toBe(200);
    expect(await probeBody(urlOf(server, '/old'), 2000)).toEqual({ status: 200, body: 'ok' });
    expect(await probeStatus(`${urlOf(server, '/old')}`.replace('/old', '/gone'), 2000)).toBe(404);
    expect(await probeStatus(urlOf(server, '/loop'), 2000)).toBeUndefined();
    expect(await probeStatus(urlOf(server, '/same'), 2000)).toBe(304);
  });

  it('takes an answer that switches protocols as an answer, 101, though none was asked for, and settles', async () => {
    const sockets: Socket[] = [];
    const raw = createNetServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => undefined);
      socket.once('data', () => socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\n'));
    });
    await new Promise<void>((resolve) => raw.listen(0, '127.0.0.1', resolve));
    const address = raw.address();
    if (address === null || typeof address === 'string') throw new Error('the server has no port');
    try {
      const answer = await Promise.race([probeStatus(`http://127.0.0.1:${address.port}/`, 2000), new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 1500))]);
      expect(answer).toBe(101);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(sockets.every((socket) => socket.destroyed)).toBe(true);
    } finally {
      await new Promise((resolve) => raw.close(resolve));
    }
  });

  it('settles when the socket closes before any answer, and only once', async () => {
    const server = await serve((request) => request.socket.destroy());
    expect(await probeStatus(urlOf(server), 1000)).toBeUndefined();
  });

  it('is not undone by a socket that refuses its type-of-service option, which the built-in fetch throws on from a socket event and no try and catch around it can stop', async () => {
    const refused: Error[] = [];
    const onUncaught = (error: Error): void => void refused.push(error);
    process.on('uncaughtException', onUncaught);
    vi.spyOn(Socket.prototype, 'setTypeOfService').mockImplementation(() => {
      throw Object.assign(new Error('setTypeOfService EINVAL'), { code: 'EINVAL', syscall: 'setTypeOfService' });
    });
    try {
      const server = await serve((_request, response) => response.end('ready'));
      expect(await probeStatus(urlOf(server), 2000)).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(refused).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('shows that the built-in fetch is what throws there, so the test above can tell', async () => {
    const refused: Error[] = [];
    const onUncaught = (error: Error): void => void refused.push(error);
    process.on('uncaughtException', onUncaught);
    vi.spyOn(Socket.prototype, 'setTypeOfService').mockImplementation(() => {
      throw Object.assign(new Error('setTypeOfService EINVAL'), { code: 'EINVAL', syscall: 'setTypeOfService' });
    });
    try {
      const server = await serve((_request, response) => response.end('ready'));
      await fetch(urlOf(server), { signal: AbortSignal.timeout(1000) }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(refused.map((error) => Reflect.get(error, 'syscall'))).toContain('setTypeOfService');
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });
});
