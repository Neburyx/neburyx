import { spawn } from 'node:child_process';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const web = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'web');
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') return reject(new Error('no port'));
      server.close(() => resolve(address.port));
    });
  });
}

async function stubApi(port: number): Promise<void> {
  const server: Server = createHttpServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ from: 'the stub api', path: request.url }));
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  stops.push(() => new Promise((resolve) => server.close(() => resolve())));
}

async function startVite(webPort: number, apiUrl: string): Promise<void> {
  const child = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
    cwd: web,
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', NEBURYX_DEV_API_URL: apiUrl },
    stdio: 'ignore',
  });
  stops.push(
    () =>
      new Promise((resolve) => {
        child.once('close', () => resolve());
        child.kill('SIGTERM');
      }),
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${webPort}/`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('the web dev server did not start');
}

describe('the web dev server', () => {
  it('answers its root, and sends /v1, /healthz and /readyz to the API on a port that is not the default', async () => {
    const apiPort = await freePort();
    const webPort = await freePort();
    await stubApi(apiPort);
    await startVite(webPort, `http://127.0.0.1:${apiPort}`);
    expect((await fetch(`http://127.0.0.1:${webPort}/`)).status).toBe(200);
    for (const path of ['/v1/sources', '/healthz', '/readyz']) {
      const response = await fetch(`http://127.0.0.1:${webPort}${path}`);
      expect(response.status, path).toBe(200);
      expect(await response.json(), path).toEqual({ from: 'the stub api', path });
    }
  }, 60_000);

  it('listens on 127.0.0.1 only', async () => {
    const webPort = await freePort();
    await startVite(webPort, 'http://127.0.0.1:1');
    const server = createServer();
    await expect(new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(webPort, '127.0.0.1', () => resolve());
    })).rejects.toThrow(/EADDRINUSE/);
    server.close();
  }, 60_000);
});
