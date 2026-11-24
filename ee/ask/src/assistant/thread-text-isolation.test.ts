import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FOLDERS = ['ee', 'services', 'packages', 'apps', 'tools'];
/** The one reader of the text columns of a stored turn is the thread store, for the thread route; the migrations that make and change the table name them too, and the statement of the hand test tool that empties them in a test database (it reads none). */
const ALLOWED = new Set(['ee/ask/src/assistant/thread-store.ts', 'ee/migrations/0008-assistant-threads.sql', 'ee/migrations/0009-assistant-pending-confirmations.sql', 'ee/migrations/0013-assistant-thread-text.sql', 'tools/dev/old-row-turn.sql']);
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

/** The files that reach the text through the store's own read or the presenter and are not the route that sends it. */
const REACHES_TEXT = /\b(?:thread-present|AssistantThreadRead|StoredTurnText|presentThread)\b/u;
const ALLOWED_READERS = new Set(['ee/ask/src/assistant/thread-route.ts', 'ee/ask/src/assistant/thread-present.ts', 'ee/ask/src/assistant/thread-store.ts', 'packages/contracts/src/assistant-thread.ts', 'packages/contracts/src/index.ts']);
const forbiddenReaders = (files: readonly { readonly path: string; readonly text: string }[]): string[] => files.filter((file) => REACHES_TEXT.test(file.text) && !ALLOWED_READERS.has(file.path)).map((file) => file.path);

/** Whether the statement that gives the router its context selects any text of a stored turn. */
const contextSelectsText = (statement: string): boolean => /question_text|\banswer\b|mask_on|sensitivity_version/u.test(statement);

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
    expect(contextSelectsText(context)).toBe(false);
  });

  it('canary: the same check fails a new route, export or log module that names a column or the table, and passes the thread store and the migration', () => {
    const named = 'SELECT question_text FROM assistant_turns WHERE id = $1';
    expect(forbiddenNamers([{ path: 'services/api/src/graph/new-route.ts', text: named }, { path: 'services/api/src/audit/new-export.ts', text: 'FROM assistant_turns' }, { path: 'ee/ask/src/assistant/thread-store.ts', text: named }, { path: 'ee/migrations/0013-assistant-thread-text.sql', text: 'ALTER TABLE assistant_turns ADD COLUMN question_text text' }])).toEqual(['services/api/src/graph/new-route.ts', 'services/api/src/audit/new-export.ts']);
    expect(sources).toContain('ee/ask/src/assistant/thread-store.ts');
  });

  it('is sent by the thread route alone: no other module imports the presenter or names the read of the store that carries it', () => {
    expect(forbiddenReaders(sources.map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') })))).toEqual([]);
  });

  it('canary: the same check fails a new module that imports the presenter or names the stored text, and the check of the context statement fails one that selects it', () => {
    expect(forbiddenReaders([{ path: 'ee/ask/src/assistant/new-export.ts', text: "import { presentThread } from './thread-present.js';" }, { path: 'services/api/src/graph/new-route.ts', text: 'const turns: StoredTurnText[] = [];' }, { path: 'ee/ask/src/assistant/thread-route.ts', text: "import { presentThread } from './thread-present.js';" }])).toEqual(['ee/ask/src/assistant/new-export.ts', 'services/api/src/graph/new-route.ts']);
    expect(contextSelectsText('SELECT t.route, t.question_text FROM assistant_turns t')).toBe(true);
    expect(contextSelectsText('SELECT t.route, t.outcome FROM assistant_turns t')).toBe(false);
  });
});
