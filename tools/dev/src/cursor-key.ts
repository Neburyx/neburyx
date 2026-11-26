import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { ConfigUnusable } from './config.js';
import type { Files } from './files.js';

const CURSOR_KEY_VARIABLE = 'NEBURYX_CURSOR_KEY';
const SUFFIX = '.cursor-key';
const KEY_BYTES = 32;

/** What the API accepts as `NEBURYX_CURSOR_KEY`: standard base64, padding optional, with no second spelling, of at least 32 bytes. */
const isCursorKey = (text: string): boolean => {
  const bytes = Buffer.from(text, 'base64');
  const canonical = bytes.toString('base64');
  return bytes.length >= KEY_BYTES && (text === canonical || text === canonical.replace(/=+$/, ''));
};

const isInside = (folder: string, path: string): boolean => {
  const from = relative(folder, path);
  return from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from);
};

/**
 * The cursor key of a development run, kept across runs so that open pages survive a restart: the shell's own value when it has one, otherwise the key of the file beside the settings file, made on the first run and
 * readable by its owner only. The file is never inside the repository, where it could be committed. Every message names the file and never what it holds.
 */
export function devCursorKey(env: Readonly<Record<string, string | undefined>>, settingsPath: string, repository: string, files: Files, random: (bytes: number) => Buffer): string {
  const given = env[CURSOR_KEY_VARIABLE] ?? '';
  if (given !== '') return given;
  const path = `${settingsPath}${SUFFIX}`;
  // where the file really is, through any link: its own target when it is there, and otherwise its folder's
  const real = files.exists(path) ? files.realPath(path) : join(files.realPath(dirname(path)), basename(path));
  if (isInside(files.realPath(repository), real)) throw new ConfigUnusable(`the cursor key file ${path} would be inside the repository; name a settings file outside it, or set ${CURSOR_KEY_VARIABLE} in your shell`);
  if (!files.exists(path)) {
    const made = random(KEY_BYTES).toString('base64');
    let created: boolean;
    try {
      created = files.createPrivate(path, `${made}\n`);
    } catch {
      throw new ConfigUnusable(`the cursor key file ${path} cannot be written`);
    }
    if (created) return made;
  }
  // a link to nothing is there for the exclusive create and not for the reader
  if (!files.exists(path)) throw new ConfigUnusable(`the cursor key file ${path} cannot be read; remove it, and the next run makes a new key`);
  const mode = files.mode(path);
  if ((mode & ~0o600) !== 0) throw new ConfigUnusable(`the cursor key file ${path} has mode 0${mode.toString(8)}, wider than 0600; run chmod 600 on it`);
  const kept = files.read(path).trim();
  if (!isCursorKey(kept)) throw new ConfigUnusable(`the cursor key file ${path} does not hold base64 of at least ${KEY_BYTES} bytes; remove it, and the next run makes a new key`);
  return kept;
}
