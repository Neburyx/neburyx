import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Files } from './up.js';

export const nodeFiles: Files = {
  exists: existsSync,
  read: (path) => readFileSync(path, 'utf8'),
  mode: (path) => statSync(path).mode & 0o777,
  write: (path, text, mode) => writeFileSync(path, text, { flag: 'wx', mode }),
  mkdir: (path) => void mkdirSync(path, { recursive: true }),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
};
