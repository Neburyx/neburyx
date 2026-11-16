import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FOLDERS = ['ee', 'services', 'packages', 'apps', 'tools'];
const ALLOWED = new Set(['ee/ask/src/case-summary/run-store.ts', 'ee/migrations/0006-summary-runs.sql']);
const SKIPPED = new Set(['node_modules', 'dist', 'coverage', '.turbo']);

function filesUnder(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    if (SKIPPED.has(name)) return [];
    const path = join(folder, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** The files that name a stored-record table and are not allowed to. */
const forbiddenNamers = (files: readonly { readonly path: string; readonly text: string }[]): string[] => files.filter((file) => /summary_run(s|_calls)/.test(file.text) && !ALLOWED.has(file.path)).map((file) => file.path);

describe('the stored case summary records', () => {
  const sources = FOLDERS.flatMap((folder) => filesUnder(join(ROOT, folder)))
    .map((path) => relative(ROOT, path))
    .filter((path) => /\.(ts|tsx|js|mjs|sql|yaml|yml)$/.test(path) && !/\.test\.ts$/.test(path));

  it('are named in the run store and the migration only: no route, query or export reads the tables', () => {
    expect(forbiddenNamers(sources.map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') })))).toEqual([]);
  });

  it('are only written and removed by the store: it holds no SELECT', () => {
    const text = readFileSync(join(ROOT, 'ee/ask/src/case-summary/run-store.ts'), 'utf8');
    expect(text).not.toMatch(/\bSELECT\b/i);
  });

  it('canary: the same check fails a new route, export or log module that names a table, and passes the store and the migration', () => {
    const named = "SELECT * FROM summary_run_calls WHERE run_id = $1";
    expect(forbiddenNamers([{ path: 'services/api/src/graph/new-route.ts', text: named }, { path: 'ee/ask/src/case-summary/run-store.ts', text: named }, { path: 'ee/migrations/0006-summary-runs.sql', text: 'CREATE TABLE summary_runs' }])).toEqual(['services/api/src/graph/new-route.ts']);
    expect(sources).toContain('ee/ask/src/case-summary/run-store.ts');
  });
});

describe('the observer of the checks', () => {
  const OBSERVER_USERS = new Set(['ee/ask/src/case-summary/summarizer.ts', 'ee/ask/src/eval/summary.ts', 'ee/ask/src/eval/index.ts', 'tools/summary-suite/src/eval/hooks.ts', 'tools/summary-suite/src/eval/run.ts']);
  const sources = FOLDERS.flatMap((folder) => filesUnder(join(ROOT, folder)))
    .map((path) => relative(ROOT, path))
    .filter((path) => /\.(ts|tsx|mjs)$/.test(path) && !/\.test\.ts$/.test(path));
  const namers = (files: readonly { readonly path: string; readonly text: string }[]): string[] => files.filter((file) => (/ReplyObservation/.test(file.text) || (/createCaseSummarizer/.test(file.text) && /\bobserve\b/.test(file.text))) && !OBSERVER_USERS.has(file.path)).map((file) => file.path);

  it('is named by the summarizer and the evaluation module and command only: the extension, the routes, the events and the records do not build or pass it', () => {
    expect(namers(sources.map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') })))).toEqual([]);
  });

  it('canary: the same check fails a route that passes an observer', () => {
    expect(namers([{ path: 'ee/ask/src/index.ts', text: 'createCaseSummarizer({ observe: (o) => log(o) })' }, { path: 'ee/ask/src/case-summary/summarizer.ts', text: 'readonly observe?: (observation: ReplyObservation) => void;' }])).toEqual(['ee/ask/src/index.ts']);
  });
});
