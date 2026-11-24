import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FOLDERS = ['ee', 'services', 'packages', 'apps', 'tools'];
const ALLOWED = new Set(['ee/ask/src/assistant/run-store.ts', 'ee/ask/src/assistant/thread-store.ts', 'ee/migrations/0007-assistant-runs.sql', 'ee/migrations/0010-assistant-run-errors.sql', 'ee/migrations/0012-assistant-run-tools.sql', 'ee/migrations/0014-assistant-thread-person-epochs.sql', 'tools/ask-eval/src/thread/records.ts']);
// the thread store names the tables once, in the statement that blanks the call text when a person clears their thread (checked below); and the one named exception beyond the store and the migration: the evaluation reader of tools/ask-eval, which only reads the records of a run it made, by trace id, with a read-only login; no route, query or export of the product reads them
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

/** The lines of a file that name a record table other than inside the one constant that blanks the text. */
const outsideBlankingStatement = (text: string): string[] => text.split('\n').filter((line) => /assistant_run(s|_calls)/.test(line) && !line.startsWith('const BLANK_OWN_CALLS = '));

/** The lines that hold a SELECT other than the two statements of the guard (the run's own count and the lock of the investigation row). */
const selectsOutsideGuard = (text: string): string[] => text.split('\n').filter((line) => /\bSELECT\b/i.test(line) && !/^const (READ_RUN_GUARD|LOCK_FOR_RUN_WRITE) = /.test(line) && !/^ *\/[*]/.test(line) && !/^ *[*]/.test(line));

describe('the stored assistant turn records', () => {
  const sources = FOLDERS.flatMap((folder) => filesUnder(join(ROOT, folder)))
    .map((path) => relative(ROOT, path))
    .filter((path) => /\.(ts|tsx|js|mjs|sql|yaml|yml)$/.test(path) && !/\.test\.ts$/.test(path));

  it('are named in the run store and the migration only: no route, query or export reads the tables', () => {
    expect(forbiddenNamers(sources.map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') })))).toEqual([]);
  });

  it('are only written and removed by the store: its SELECTs are the guard of a write, which reads no text of a call', () => {
    const text = readFileSync(join(ROOT, 'ee/ask/src/assistant/run-store.ts'), 'utf8');
    expect(selectsOutsideGuard(text)).toEqual([]);
    expect(text.match(/\bSELECT\b/gi)?.length).toBe(2);
  });

  it('canary: a SELECT of the text of a call is found', () => {
    expect(selectsOutsideGuard("const READ = 'SELECT values_text FROM assistant_run_calls';")).toHaveLength(1);
    expect(selectsOutsideGuard("const READ_RUN_GUARD = 'SELECT actor_id, investigation_id, thread_epoch FROM assistant_runs WHERE id = $1';")).toEqual([]);
  });

  it('are named by the thread store only in the one statement that blanks the text of a person’s calls, which selects no text and deletes no row', () => {
    const text = readFileSync(join(ROOT, 'ee/ask/src/assistant/thread-store.ts'), 'utf8');
    expect(outsideBlankingStatement(text)).toEqual([]);
    const blanking = /const BLANK_OWN_CALLS = ("[^"]*");/.exec(text)?.[1] ?? '';
    expect(blanking).toMatch(/^"UPDATE assistant_run_calls SET values_text = '', reply_text = NULL WHERE run_id IN \(SELECT id FROM assistant_runs WHERE actor_id = \$2 AND investigation_id = \$1\)"$/);
  });

  it('canary: the thread store check fails a statement that reads the call text or deletes the rows', () => {
    expect(outsideBlankingStatement("const READ = 'SELECT values_text FROM assistant_run_calls';")).toHaveLength(1);
    expect(outsideBlankingStatement("const BLANK_OWN_CALLS = \"UPDATE assistant_run_calls SET values_text = ''\";\nconst GONE = 'DELETE FROM assistant_runs';")).toHaveLength(1);
  });

  it('canary: the same check fails a new route, export or log module that names a table, and passes the store and the migration', () => {
    const named = "SELECT * FROM assistant_run_calls WHERE run_id = $1";
    expect(forbiddenNamers([{ path: 'services/api/src/graph/new-route.ts', text: named }, { path: 'ee/ask/src/assistant/run-store.ts', text: named }, { path: 'ee/migrations/0007-assistant-runs.sql', text: 'CREATE TABLE assistant_runs' }])).toEqual(['services/api/src/graph/new-route.ts']);
    expect(sources).toContain('ee/ask/src/assistant/run-store.ts');
  });
});
