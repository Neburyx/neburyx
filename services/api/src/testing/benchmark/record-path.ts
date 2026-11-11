import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECORD_DIRECTORY_VARIABLE = 'NBX_BENCH_RECORD_DIR';

const COMMITTED_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../docs/benchmarks');

/** The folder the supernode benchmark writes its record into: the one the variable names, else the committed `docs/benchmarks`. */
export function recordDirectory(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const named = env[RECORD_DIRECTORY_VARIABLE];
  return named === undefined || named === '' ? COMMITTED_DIRECTORY : resolve(named);
}
