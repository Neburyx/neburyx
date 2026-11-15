import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readTokenKeys } from './token-keys.js';

const root = mkdtempSync(join(tmpdir(), 'case-summary-keys-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const SENTINEL = 'SENTINEL-KEY-CONTENT';
const HEX_A = 'ab'.repeat(32);
const HEX_B = 'cd'.repeat(32);

function file(name: string, content: string, mode = 0o600): string {
  const path = join(root, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

const problemsOf = async (env: Record<string, string>): Promise<readonly string[]> => {
  const read = await readTokenKeys(env);
  return read.ok ? [] : read.problems;
};

describe('the key files of the summary token', () => {
  it('reads no key when none is named, which leaves the summary unavailable', async () => {
    expect(await readTokenKeys({})).toEqual({ ok: true, keys: undefined });
    expect(await readTokenKeys({ NEBURYX_SUMMARY_TOKEN_KEY_FILE: '' })).toEqual({ ok: true, keys: undefined });
  });

  it('reads a key of 64 hexadecimal characters with or without a trailing newline, and the previous key for a rotation', async () => {
    const read = await readTokenKeys({ NEBURYX_SUMMARY_TOKEN_KEY_FILE: file('a', `${HEX_A}\n`), NEBURYX_SUMMARY_TOKEN_KEY_PREVIOUS_FILE: file('b', HEX_B) });
    expect(read.ok && read.keys?.current.bytes.length).toBe(32);
    expect(read.ok && read.keys?.previous?.bytes.length).toBe(32);
    expect(read.ok && read.keys?.current.kid).toMatch(/^[0-9a-f]{8}$/);
    expect(read.ok && read.keys?.current.kid).not.toBe(read.ok && read.keys?.previous?.kid);
  });

  it.each([
    ['missing', () => join(root, 'nope'), 'the file cannot be read'],
    ['a directory', () => root, 'not a regular file'],
    ['readable by the group', () => file('g', HEX_A, 0o640), 'owner-only'],
    ['empty', () => file('e', ''), '256-bit key'],
    ['too short', () => file('s', 'ab'.repeat(31)), '256-bit key'],
    ['not hexadecimal', () => file('x', `${SENTINEL}${'z'.repeat(44)}`), '256-bit key'],
    ['uppercase hexadecimal', () => file('u', 'AB'.repeat(32)), '256-bit key'],
    ['too long', () => file('l', `${HEX_A}${HEX_A}`), '256-bit key'],
    ['a relative path', () => 'key.txt', 'absolute path'],
  ])('refuses a key file that is %s, naming the setting and printing neither path nor content', async (_name, make, expected) => {
    const path = make();
    for (const variable of ['NEBURYX_SUMMARY_TOKEN_KEY_FILE', 'NEBURYX_SUMMARY_TOKEN_KEY_PREVIOUS_FILE']) {
      const env: Record<string, string> = variable === 'NEBURYX_SUMMARY_TOKEN_KEY_FILE' ? { [variable]: path } : { NEBURYX_SUMMARY_TOKEN_KEY_FILE: file('good', HEX_A), [variable]: path };
      const problems = await problemsOf(env);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(variable);
      expect(problems[0]).toContain(expected);
      expect(problems.join()).not.toContain(path);
      expect(problems.join()).not.toContain(SENTINEL);
    }
  });

  it('refuses a symbolic link', async () => {
    const target = file('target', HEX_A);
    const link = join(root, 'link');
    symlinkSync(target, link);
    expect(await problemsOf({ NEBURYX_SUMMARY_TOKEN_KEY_FILE: link })).toEqual(['NEBURYX_SUMMARY_TOKEN_KEY_FILE: the file cannot be read']);
  });

  it('refuses a named pipe without waiting on it', async () => {
    const { execFileSync } = await import('node:child_process');
    const pipe = join(root, 'pipe');
    mkdirSync(join(root, 'p'), { recursive: true });
    execFileSync('/usr/bin/mkfifo', [pipe]);
    expect(await problemsOf({ NEBURYX_SUMMARY_TOKEN_KEY_FILE: pipe })).toEqual(['NEBURYX_SUMMARY_TOKEN_KEY_FILE: the path is not a regular file']);
  });

  it('refuses the same key in both files, and a previous key with no current key', async () => {
    const same = await problemsOf({ NEBURYX_SUMMARY_TOKEN_KEY_FILE: file('same1', HEX_A), NEBURYX_SUMMARY_TOKEN_KEY_PREVIOUS_FILE: file('same2', HEX_A) });
    expect(same).toEqual(['NEBURYX_SUMMARY_TOKEN_KEY_PREVIOUS_FILE holds the same key as NEBURYX_SUMMARY_TOKEN_KEY_FILE']);
    expect(await problemsOf({ NEBURYX_SUMMARY_TOKEN_KEY_PREVIOUS_FILE: file('only', HEX_A) })).toEqual(['NEBURYX_SUMMARY_TOKEN_KEY_PREVIOUS_FILE is set and NEBURYX_SUMMARY_TOKEN_KEY_FILE is not']);
  });
});
