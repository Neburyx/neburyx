import { fileURLToPath } from 'node:url';
import { createLogger } from './logger.js';
import { start } from './start.js';

const result = await start(process.env, {
  stderr: process.stderr,
  logger: createLogger(),
  defaultWebRoot: fileURLToPath(new URL('../../../apps/web/dist', import.meta.url)),
});

if (result.exitCode !== 0) process.exit(result.exitCode);
