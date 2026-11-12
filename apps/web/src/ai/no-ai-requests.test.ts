// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = join(import.meta.dirname, '..');
const AI_PATHS = ['/v1/ai', '/v1/ask', '/v1/assistant', '/v1/summary'];

/** The files of the web app that may name an AI path: the client module of each AI feature, added by that feature. None exists yet. */
const ALLOWED: readonly string[] = [];

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe('the web app', () => {
  it('names no AI path in a source file, so no part of it can call one, except the files a feature added to the allowed list', () => {
    const naming = files(SOURCE)
      .filter((path) => AI_PATHS.some((aiPath) => readFileSync(path, 'utf8').includes(aiPath)))
      .map((path) => relative(SOURCE, path));
    expect(naming.filter((path) => !ALLOWED.includes(path))).toEqual([]);
  });
});
