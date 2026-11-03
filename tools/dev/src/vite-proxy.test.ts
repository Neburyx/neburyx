import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { terminateGroup } from './processes.js';

const web = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'web');
const GRACE_MS = 3000;
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
  const server = createHttpServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ from: 'the stub api', path: request.url }));
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  stops.push(() => new Promise((resolve) => void server.close(() => resolve())));
}

async function startVite(webPort: number, apiUrl: string): Promise<() => string> {
  const child = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
    cwd: web,
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', NEBURYX_DEV_API_URL: apiUrl },
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true,
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  stops.push(async () => {
    if (child.pid !== undefined) await terminateGroup(child.pid, GRACE_MS);
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${webPort}/`)).ok) return () => output;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
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

  it('listens on 127.0.0.1 only: it names no other address, and the machine’s other address refuses the connection', async () => {
    const webPort = await freePort();
    const output = await startVite(webPort, 'http://127.0.0.1:1');
    expect(output()).toContain(`http://127.0.0.1:${webPort}/`);
    expect(output()).not.toContain('Network:');
    const external = Object.values(networkInterfaces())
      .flatMap((list) => list ?? [])
      .find((entry) => entry.family === 'IPv4' && !entry.internal);
    if (external === undefined) return;
    await expect(fetch(`http://${external.address}:${webPort}/`, { signal: AbortSignal.timeout(5000) })).rejects.toThrow();
  }, 60_000);
});
