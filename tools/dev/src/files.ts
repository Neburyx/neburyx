import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Files } from './up.js';

export const nodeFiles: Files = {
  exists: existsSync,
  read: (path) => readFileSync(path, 'utf8'),
  write: (path, text, mode) => writeFileSync(path, text, { flag: 'wx', mode }),
  mkdir: (path) => void mkdirSync(path, { recursive: true }),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
};
