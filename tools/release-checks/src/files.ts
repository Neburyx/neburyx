import { readdir, readFile } from 'node:fs/promises';

export interface Files {
  readonly readText: (path: string) => Promise<string>;
  readonly folders: (path: string) => Promise<readonly string[]>;
}

export const diskFiles: Files = {
  readText: (path) => readFile(path, 'utf8'),
  folders: async (path) => (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name),
};

