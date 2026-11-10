import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A directory of its own for the files of one test process; start-up creates it with the right mode. */
export function makeExportDirectory(): string {
  return join(mkdtempSync(join(tmpdir(), 'nbx-exports-')), 'exports');
}
