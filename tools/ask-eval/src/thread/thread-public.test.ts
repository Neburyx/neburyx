import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..', '..', '..', '..');
const SURFACE = ['tools/ask-eval', 'ee', 'services/api/src/migrate', 'docs'];
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

const signaturesPath = process.env['NEBURYX_PRIVATE_SIGNATURES'];

/** The private signatures (anchors, term lists, trial figures) are kept outside every repository: one JSON array of patterns in the file the environment names. A file that is named and cannot be read as that fails the test. */
function privateSignatures(path: string): RegExp[] {
  if (!existsSync(path)) throw new Error('NEBURYX_PRIVATE_SIGNATURES names a file that does not exist');
  if (relative(root, path).startsWith('..') === false) throw new Error('NEBURYX_PRIVATE_SIGNATURES names a file inside the repository');
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((entry) => typeof entry === 'string' && entry !== '')) throw new Error('NEBURYX_PRIVATE_SIGNATURES is not a non-empty JSON array of patterns');
  return parsed.map((entry) => new RegExp(String(entry), 'iu'));
}

describe('the public surface of the thread evaluation', () => {
  const files = SURFACE.flatMap(filesOf);

  it('scans the whole changed public surface, this file included', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(join(here, 'thread-public.test.ts'));
    expect(files.some((file) => file.endsWith('0012-assistant-run-tools.sql'))).toBe(true);
  });

  it('holds no roadmap, requirement or decision identifier', () => {
    expect(matches(files, GENERIC)).toEqual([]);
  });

  it.skipIf(signaturesPath === undefined)('holds none of the private signatures supplied from outside the repository (skipped, and shown as skipped, when none are supplied)', () => {
    expect(matches(files, privateSignatures(signaturesPath ?? ''))).toEqual([]);
  });

  it('refuses a signatures file that is missing, malformed or inside the repository, so that an unavailable private check is never a clean scan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-signatures-'));
    writeFileSync(join(dir, 'empty.json'), '[]');
    writeFileSync(join(dir, 'text.json'), '"x"');
    expect(() => privateSignatures(join(dir, 'missing.json'))).toThrow('does not exist');
    expect(() => privateSignatures(join(dir, 'empty.json'))).toThrow('non-empty');
    expect(() => privateSignatures(join(dir, 'text.json'))).toThrow('non-empty');
    expect(() => privateSignatures(join(here, 'thread-public.test.ts'))).toThrow('inside the repository');
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
