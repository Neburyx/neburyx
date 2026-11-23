import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FOLDERS = ['ee', 'services', 'packages', 'apps', 'tools'];
const ALLOWED = new Set(['ee/ask/src/assistant/run-store.ts', 'ee/migrations/0007-assistant-runs.sql', 'ee/migrations/0010-assistant-run-errors.sql']);
const SKIPPED = new Set(['node_modules', 'dist', 'coverage', '.turbo']);

function filesUnder(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    if (SKIPPED.has(name)) return [];
    const path = join(folder, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** The files that name a stored-record table and are not allowed to. */
const forbiddenNamers = (files: readonly { readonly path: string; readonly text: string }[]): string[] => files.filter((file) => /assistant_run(s|_calls)/.test(file.text) && !ALLOWED.has(file.path)).map((file) => file.path);

describe('the stored assistant turn records', () => {
  const sources = FOLDERS.flatMap((folder) => filesUnder(join(ROOT, folder)))
    .map((path) => relative(ROOT, path))
    .filter((path) => /\.(ts|tsx|js|mjs|sql|yaml|yml)$/.test(path) && !/\.test\.ts$/.test(path));

  it('are named in the run store and the migration only: no route, query or export reads the tables', () => {
    expect(forbiddenNamers(sources.map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') })))).toEqual([]);
  });

  it('are only written and removed by the store: it holds no SELECT', () => {
    const text = readFileSync(join(ROOT, 'ee/ask/src/assistant/run-store.ts'), 'utf8');
    expect(text).not.toMatch(/\bSELECT\b/i);
  });

  it('canary: the same check fails a new route, export or log module that names a table, and passes the store and the migration', () => {
    const named = "SELECT * FROM assistant_run_calls WHERE run_id = $1";
    expect(forbiddenNamers([{ path: 'services/api/src/graph/new-route.ts', text: named }, { path: 'ee/ask/src/assistant/run-store.ts', text: named }, { path: 'ee/migrations/0007-assistant-runs.sql', text: 'CREATE TABLE assistant_runs' }])).toEqual(['services/api/src/graph/new-route.ts']);
    expect(sources).toContain('ee/ask/src/assistant/run-store.ts');
  });
});
