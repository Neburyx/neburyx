import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE_FOLDER = fileURLToPath(new URL('.', import.meta.url));
const STDOUT_WRITE = /process\.stdout\b/;

function writesToStdout(text: string): boolean {
  return STDOUT_WRITE.test(text);
}

function sourceFilesOutsideTests(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = `${folder}${entry.name}`;
    if (entry.isDirectory()) return sourceFilesOutsideTests(`${path}/`);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('the source of ee/ask', () => {
  it('has no process.stdout write in the source outside test files', () => {
    const offenders = sourceFilesOutsideTests(SOURCE_FOLDER).filter((path) => writesToStdout(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('finds a process.stdout write in a sample text, so the search does not pass vacuously', () => {
    expect(writesToStdout("process.stdout.write('a line');")).toBe(true);
    expect(writesToStdout('logger.warn({ event: "x" }, "y");')).toBe(false);
  });
});
