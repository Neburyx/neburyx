import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StepFailed } from './compose.js';
import { run } from './exec.js';
import { IncompleteExternalDatabase } from './external.js';
import { LockHeld } from './lock.js';
import { SettingsInvalid, down, up, type Dependencies } from './up.js';
import { supervise } from './supervisor.js';

const USAGE = 'usage: dev (up | down)';

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

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  if ((command !== 'up' && command !== 'down') || argv.length !== 1) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const stopRequested = new Promise<void>((resolveStop) => {
    process.once('SIGINT', () => resolveStop());
    process.once('SIGTERM', () => resolveStop());
  });
  const deps: Dependencies = {
    root: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
    run,
    env: process.env,
    out: (text) => void process.stdout.write(`${text}\n`),
    random: (bytes) => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes))),
    files: {
      exists: existsSync,
      read: (path) => readFileSync(path, 'utf8'),
      write: (path, text, mode) => writeFileSync(path, text, { flag: 'wx', mode }),
      mkdir: (path) => void mkdirSync(path, { recursive: true }),
      remove: (path) => rmSync(path, { recursive: true, force: true }),
    },
    nodePath: process.execPath,
    freePort,
    supervise,
    stopRequested,
    lock: {},
  };
  try {
    return await (command === 'up' ? up(deps) : down(deps));
  } catch (error) {
    if (error instanceof LockHeld || error instanceof SettingsInvalid || error instanceof IncompleteExternalDatabase || error instanceof StepFailed) {
      process.stderr.write(`dev: ${error.message}\n`);
      return 1;
    }
    process.stderr.write('dev: an unexpected error stopped the command\n');
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
