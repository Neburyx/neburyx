import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FOLDERS = ['ee', 'services', 'packages', 'apps', 'tools'];
/** The one reader of the text columns of a stored turn is the thread store, for the thread route; the migrations that make and change the table name them too. */
const ALLOWED = new Set(['ee/ask/src/assistant/thread-store.ts', 'ee/migrations/0008-assistant-threads.sql', 'ee/migrations/0009-assistant-pending-confirmations.sql', 'ee/migrations/0013-assistant-thread-text.sql']);
const SKIPPED = new Set(['node_modules', 'dist', 'coverage', '.turbo']);

function filesUnder(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    if (SKIPPED.has(name)) return [];
    const path = join(folder, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** The files that name a text column of a stored turn, or the table that holds them, and are not allowed to. */
const forbiddenNamers = (files: readonly { readonly path: string; readonly text: string }[]): string[] =>
  files.filter((file) => /\b(?:question_text|mask_on|sensitivity_version)\b|\bassistant_turns\b/u.test(file.text) && !ALLOWED.has(file.path)).map((file) => file.path);

describe('the text a thread keeps', () => {
  const sources = FOLDERS.flatMap((folder) => filesUnder(join(ROOT, folder)))
    .map((path) => relative(ROOT, path))
    .filter((path) => /\.(ts|tsx|js|mjs|sql|yaml|yml)$/u.test(path) && !/\.test\.ts$/u.test(path));

  it('is read from its columns by the thread store alone: no route, query, export or log names a column of it or the table of the turns', () => {
    expect(forbiddenNamers(sources.map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') })))).toEqual([]);
  });

  it('is not selected by the statement that gives the router its context', () => {
    const text = readFileSync(join(ROOT, 'ee/ask/src/assistant/thread-store.ts'), 'utf8');
    const context = /const READ_CONTEXT =\s*'([^']+)'/u.exec(text)?.[1] ?? '';
    expect(context).toContain('FROM assistant_turns');
    expect(context).not.toMatch(/question_text|\banswer\b|mask_on|sensitivity_version/u);
  });

  it('canary: the same check fails a new route, export or log module that names a column or the table, and passes the thread store and the migration', () => {
    const named = 'SELECT question_text FROM assistant_turns WHERE id = $1';
    expect(forbiddenNamers([{ path: 'services/api/src/graph/new-route.ts', text: named }, { path: 'services/api/src/audit/new-export.ts', text: 'FROM assistant_turns' }, { path: 'ee/ask/src/assistant/thread-store.ts', text: named }, { path: 'ee/migrations/0013-assistant-thread-text.sql', text: 'ALTER TABLE assistant_turns ADD COLUMN question_text text' }])).toEqual(['services/api/src/graph/new-route.ts', 'services/api/src/audit/new-export.ts']);
    expect(sources).toContain('ee/ask/src/assistant/thread-store.ts');
  });

  it('canary: a context statement that selected the text would fail the check of the statement', () => {
    const selecting = "SELECT t.route, t.question_text, t.answer FROM assistant_turns t";
    expect(/question_text|\banswer\b/u.test(selecting)).toBe(true);
  });
});
