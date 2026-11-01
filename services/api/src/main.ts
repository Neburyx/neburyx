import { fileURLToPath } from 'node:url';
import { createLogger } from './logger.js';
import { serve } from './serve.js';

await serve(
  process.env,
  {
    stderr: process.stderr,
    logger: createLogger(),
    defaultWebRoot: fileURLToPath(new URL('../../../apps/web/dist', import.meta.url)),
  },
  process,
);
