import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './cli.js';
import { createProductDeps } from '../product/playwright.js';
import { createRealDeps } from './playwright.js';

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

process.exitCode = await runCli(process.argv.slice(2), createRealDeps(PACKAGE_ROOT), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
}, createProductDeps());
