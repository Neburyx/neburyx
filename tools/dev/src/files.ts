import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';

/** What the tool needs from the file system: it reads, and writes one kind of file, a new one of its own that only the owner can read. */
export interface Files {
  exists(path: string): boolean;
  read(path: string): string;
  /** The permission bits of the file; a symlink is judged by the file it points to. */
  mode(path: string): number;
  /** The path with every link followed; the path as given when nothing is there. */
  realPath(path: string): string;
  /** Creates the file with mode 0600 from the start; false, with nothing written, when something is there already. Throws when it cannot be written. */
  createPrivate(path: string, text: string): boolean;
}

export const nodeFiles: Files = {
  exists: existsSync,
  read: (path) => readFileSync(path, 'utf8'),
  mode: (path) => statSync(path).mode & 0o777,
  realPath: (path) => (existsSync(path) ? realpathSync(path) : path),
  createPrivate(path, text) {
    try {
      writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false;
      throw error;
    }
  },
};
