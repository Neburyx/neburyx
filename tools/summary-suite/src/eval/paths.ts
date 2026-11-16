import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** A mistake in how the command was called: the message is printed and the exit code is 2. */
export class UsageError extends Error {}

/** Whether a path is inside a git working tree: some folder above it (or it) holds a `.git`. Neither repository is named. */
function insideGitTree(path: string): boolean {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  current = realpathSync(current);
  for (;;) {
    if (existsSync(resolve(current, '.git'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function requireOutsideGitTree(path: string, what: string): void {
  if (insideGitTree(path)) throw new UsageError(`${what} is inside a git working tree; a private file belongs outside every one`);
}

const GROUP_AND_OTHER = 0o077;

/** Makes the folder of a private output (mode 0700 when new), and refuses a link, a folder inside a git working tree after links are resolved, and an existing folder that group or others can reach. */
export function prepareOutFolder(path: string): void {
  const found = existsSync(path) || isLink(path) ? lstatSync(path) : undefined;
  if (found?.isSymbolicLink()) throw new UsageError('--out is a link; give the folder itself');
  if (found !== undefined && !found.isDirectory()) throw new UsageError('--out is not a folder');
  if (found !== undefined && (found.mode & GROUP_AND_OTHER) !== 0) throw new UsageError('--out can be reached by group or others; make it owner-only (mode 0700)');
  if (found === undefined) mkdirSync(path, { recursive: true, mode: 0o700 });
  requireOutsideGitTree(realpathSync(path), '--out');
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Whether a private file can be written: not through a link, and over an existing file only when `replace` is set. Checked before a run that is paid for (so that a run that cannot record is never made), and again at the write. */
export function checkPrivateTarget(path: string, replace: boolean): void {
  if (isLink(path)) throw new UsageError('a file to write is a link; remove it first');
  if (existsSync(path) && !replace) throw new UsageError('the file is already there; --force replaces it');
}

/**
 * Writes a private file with mode 0600, never through a link: an existing link is refused, an existing file is replaced only when `replace` is set (it is removed first), and the file is created exclusively.
 */
export function writePrivateFile(path: string, text: string, replace: boolean): void {
  checkPrivateTarget(path, replace);
  if (existsSync(path)) unlinkSync(path);
  writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}
