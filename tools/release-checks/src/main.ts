import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { releaseCatalogue } from './catalogue.js';
import { neo4jConnection } from './connection.js';
import { createExec } from './exec.js';
import { runRelease } from './run.js';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());

const connection = neo4jConnection(process.env);
const code = await runRelease(process.argv.slice(2), {
  exec: createExec(controller.signal, process.env),
  signal: controller.signal,
  repoRoot,
  env: process.env,
  clock: () => new Date(),
  monotonicNowMs: () => performance.now(),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  catalogue: (options) => releaseCatalogue(repoRoot, options.image),
  extraSecrets: connection.ok ? connection.secrets : [],
  extraLogins: connection.ok ? [connection.login] : [],
});
process.exitCode = code;
