import { existsSync, readFileSync, statSync } from 'node:fs';

/** What the tool needs from the file system: it only reads. */
export interface Files {
  exists(path: string): boolean;
  read(path: string): string;
  /** The permission bits of the file; a symlink is judged by the file it points to. */
  mode(path: string): number;
}

export const nodeFiles: Files = {
  exists: existsSync,
  read: (path) => readFileSync(path, 'utf8'),
  mode: (path) => statSync(path).mode & 0o777,
};
