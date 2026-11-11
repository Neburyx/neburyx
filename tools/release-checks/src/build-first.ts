import type { ExecRequest } from './types.js';

/** The packages the API's tests import, built before any of them runs (as the root `test` script does). */
export const BUILD_FIRST: ExecRequest = { command: 'pnpm', args: ['--filter', '@neburyx/contracts', '--filter', '@neburyx/test-containers', '--filter', '@neburyx/test-neo4j', 'build'] };
