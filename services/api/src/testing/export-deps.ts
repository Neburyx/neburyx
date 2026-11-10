import { createExportFileStore } from '../exports/store.js';
import { makeExportDirectory } from './export-directory.js';
import { memoryExports } from './memory-exports.js';
import { mkdirSync } from 'node:fs';

/** Export stores for a test that does not care about exports: an empty set of rows and a directory of its own. */
export function idleExportDeps() {
  const directory = makeExportDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { exports: memoryExports({ investigations: [], isDeleted: () => false }), files: createExportFileStore(directory) };
}
