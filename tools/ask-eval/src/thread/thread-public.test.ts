import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..', '..', '..', '..');
const SURFACE = ['tools/ask-eval', 'ee/assistant-agent/src', 'ee/ask/src/assistant', 'ee/migrations', 'docs/ai-preview.md'];
const SKIPPED = new Set(['node_modules', 'dist', 'coverage']);

/** Every file of the public surface this feature changes, the scanner's own file included. */
function filesOf(path: string): string[] {
  const full = join(root, path);
  if (!existsSync(full)) return [];
  if (!statSync(full).isDirectory()) return [full];
  return readdirSync(full).flatMap((name) => (SKIPPED.has(name) ? [] : filesOf(join(path, name))));
}

/** What a public file must never hold, whatever the private list says: a roadmap, requirement or decision identifier. Written as built text so that this file does not match itself. */
const GENERIC = [new RegExp('\\bEP-\\d+'), new RegExp('\\bB-\\d{3}\\b'), new RegExp('\\bOD-\\d+')];

/** The files that match any of the patterns, by path: the scan every test of this file uses. */
function matches(files: readonly string[], patterns: readonly RegExp[]): string[] {
  return files.flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return patterns.some((pattern) => pattern.test(text)) ? [relative(root, file)] : [];
  });
}

/** The private signatures (anchors, term lists, trial figures) are kept outside every repository; a list of patterns, one JSON array of strings, is read from the file the environment names. */
function privateSignatures(): RegExp[] {
  const path = process.env['NEBURYX_PRIVATE_SIGNATURES'];
  if (path === undefined || !existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(parsed) ? parsed.flatMap((entry) => (typeof entry === 'string' && entry !== '' ? [new RegExp(entry, 'iu')] : [])) : [];
}

describe('the public surface of the thread evaluation', () => {
  const files = SURFACE.flatMap(filesOf);

  it('scans the whole changed public surface, this file included', () => {
    expect(files.length).toBeGreaterThan(30);
    expect(files).toContain(join(here, 'thread-public.test.ts'));
    expect(files.some((file) => file.endsWith('0012-assistant-run-tools.sql'))).toBe(true);
  });

  it('holds no roadmap, requirement or decision identifier', () => {
    expect(matches(files, GENERIC)).toEqual([]);
  });

  it('holds none of the private signatures when they are supplied from outside the repository', () => {
    expect(matches(files, privateSignatures())).toEqual([]);
  });

  it('fails on a planted identifier and a planted private signature, so that the scan can be seen to fail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-public-'));
    const clean = join(dir, 'clean.txt');
    const identifier = join(dir, 'identifier.txt');
    const signature = join(dir, 'signature.txt');
    writeFileSync(clean, 'nothing to see');
    writeFileSync(identifier, `a note about ${'EP'}-${23}.4`);
    writeFileSync(signature, 'the term canary-anchor-9 appears');
    expect(matches([clean, identifier, signature], GENERIC)).toEqual([relative(root, identifier)]);
    expect(matches([clean, identifier, signature], [new RegExp('canary-anchor-\\d')])).toEqual([relative(root, signature)]);
    expect(matches([clean], [...GENERIC, new RegExp('canary-anchor-\\d')])).toEqual([]);
  });
});
