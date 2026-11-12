import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../workspace.js';

const figure = (path: string, name: string): string | undefined => new RegExp(`${name} = ([\\d_]+)`).exec(readFileSync(join(repoRoot, path), 'utf8'))?.[1];

describe('the connect limit that pnpm dev counts on', () => {
  it('is the default of the API', () => {
    const api = figure('services/api/src/db/pool.ts', 'CONNECTION_TIMEOUT_MS');
    expect(api).toBeDefined();
    expect(figure('tools/dev/src/environments.ts', 'DEFAULT_CONNECT_LIMIT_MS')).toBe(api);
  });
});
