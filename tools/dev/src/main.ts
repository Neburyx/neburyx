import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './cli.js';
import { run } from './exec.js';
import { nodeFiles } from './files.js';
import { supervise } from './supervisor.js';

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') return reject(new Error('no port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

const stopRequested = new Promise<void>((resolveStop) => {
  process.once('SIGINT', () => resolveStop());
  process.once('SIGTERM', () => resolveStop());
});

process.exitCode = await main(process.argv.slice(2), {
  root: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
  run,
  env: process.env,
  out: (text) => void process.stdout.write(`${text}\n`),
  err: (text) => void process.stderr.write(`${text}\n`),
  random: (bytes) => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes))),
  files: nodeFiles,
  nodePath: process.execPath,
  freePort,
  supervise,
  stopRequested,
  lock: {},
});
