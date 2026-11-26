import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigUnusable } from './config.js';
import { devCursorKey } from './cursor-key.js';
import { nodeFiles, type Files } from './files.js';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function place() {
  const base = mkdtempSync(join(tmpdir(), 'dev-cursor-'));
  folders.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(root);
  mkdirSync(home);
  const settings = join(home, 'dev.env');
  return { base, root, home, settings, key: `${settings}.cursor-key` };
}

const random = (fill: number) => (bytes: number) => Buffer.alloc(bytes, fill);
const KEY = Buffer.alloc(32, 7).toString('base64');
const run = (at: ReturnType<typeof place>, fill = 7, env: Record<string, string> = {}, files: Files = nodeFiles): string => devCursorKey(env, at.settings, at.root, files, random(fill));
const messageOf = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigUnusable);
    return (error as Error).message;
  }
  throw new Error('it was not refused');
};

describe('the cursor key of a development run', () => {
  it('makes a key on the first run and keeps it in a file beside the settings file that only its owner can read', () => {
    const at = place();
    expect(run(at)).toBe(KEY);
    expect(Buffer.from(KEY, 'base64')).toHaveLength(32);
    expect(readFileSync(at.key, 'utf8')).toBe(`${KEY}\n`);
    expect(statSync(at.key).mode & 0o777).toBe(0o600);
  });

  it('gives every later run the same key and writes nothing', () => {
    const at = place();
    run(at);
    const written = statSync(at.key).mtimeMs;
    expect(run(at, 8)).toBe(KEY);
    expect(statSync(at.key).mtimeMs).toBe(written);
    expect(readFileSync(at.key, 'utf8')).toBe(`${KEY}\n`);
  });

  it('reads the file another run made while this one was making it', () => {
    const at = place();
    const other = Buffer.alloc(32, 3).toString('base64');
    const files: Files = { ...nodeFiles, createPrivate: (path, text) => (writeFileSync(path, `${other}\n`, { mode: 0o600 }), nodeFiles.createPrivate(path, text)) };
    expect(run(at, 7, {}, files)).toBe(other);
  });

  it('uses a key of the shell as it is, and writes no file', () => {
    const at = place();
    expect(run(at, 7, { NEBURYX_CURSOR_KEY: 'from-the-shell' })).toBe('from-the-shell');
    expect(nodeFiles.exists(at.key)).toBe(false);
    run(at);
    expect(run(at, 7, { NEBURYX_CURSOR_KEY: '' })).toBe(KEY);
  });

  it('reads a key written without padding, as openssl or a person may write it', () => {
    const at = place();
    writeFileSync(at.key, KEY.replace(/=+$/, ''), { mode: 0o600 });
    expect(run(at)).toBe(KEY.replace(/=+$/, ''));
  });

  it.each([
    ['is empty', ''],
    ['is not base64', 'not a key at all, but long enough to pass a length check ......'],
    ['holds fewer than 32 bytes', Buffer.alloc(31, 1).toString('base64')],
    ['has a second spelling', `${KEY}=`],
  ])('refuses a key file that %s, naming the file and never its content', (_name, content) => {
    const at = place();
    writeFileSync(at.key, content, { mode: 0o600 });
    const message = messageOf(() => run(at));
    expect(message).toContain(at.key);
    if (content !== '') expect(message).not.toContain(content);
    expect(readFileSync(at.key, 'utf8')).toBe(content);
  });

  it('refuses a key file that others can read', () => {
    const at = place();
    run(at);
    chmodSync(at.key, 0o644);
    const message = messageOf(() => run(at));
    expect(message).toContain(at.key);
    expect(message).toContain('0600');
    expect(message).not.toContain(KEY);
  });

  it('refuses a path it cannot write', () => {
    const at = place();
    const settings = join(at.base, 'missing-folder', 'dev.env');
    const message = messageOf(() => devCursorKey({}, settings, at.root, nodeFiles, random(7)));
    expect(message).toContain(`${settings}.cursor-key`);
    expect(message).not.toContain(KEY);
  });

  it.each([
    ['a settings file inside the repository', (at: ReturnType<typeof place>) => join(at.root, 'dev.env')],
    ['a settings file in a folder that links into the repository', (at: ReturnType<typeof place>) => (symlinkSync(at.root, join(at.home, 'linked')), join(at.home, 'linked', 'dev.env'))],
  ])('writes nothing inside the repository: it refuses %s', (_name, settingsOf) => {
    const at = place();
    const settings = settingsOf(at);
    const message = messageOf(() => devCursorKey({}, settings, at.root, nodeFiles, random(7)));
    expect(message).toContain('inside the repository');
    expect(message).toContain(`${settings}.cursor-key`);
    expect(nodeFiles.exists(join(at.root, 'dev.env.cursor-key'))).toBe(false);
  });

  it('refuses a key file that links into the repository, or to nothing, and writes nothing through it', () => {
    const at = place();
    symlinkSync(join(at.root, 'kept'), at.key);
    messageOf(() => run(at));
    expect(nodeFiles.exists(join(at.root, 'kept'))).toBe(false);
    writeFileSync(join(at.root, 'kept'), `${KEY}\n`, { mode: 0o600 });
    expect(messageOf(() => run(at))).toContain('inside the repository');
  });

  it('accepts a folder beside the repository whose name begins like it', () => {
    const at = place();
    const beside = `${at.root}-settings`;
    mkdirSync(beside);
    expect(devCursorKey({}, join(beside, 'dev.env'), at.root, nodeFiles, random(7))).toBe(KEY);
  });
});
