import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import type { TestProject } from 'vitest/node';
import { provideSeries } from './series.js';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

/** The setup of a vitest run of the Neo4j tests: stops the run at once, with a message that names what is missing, when the dev server cannot be used. The check runs in a process of its own (see packages/test-neo4j/src/check.ts). */
export default async function setup({ provide }: TestProject): Promise<void> {
  try {
    const { stdout } = await run(process.execPath, [require.resolve('@neburyx/test-neo4j/check')]);
    const version = stdout.trim();
    provideSeries(version, provide);
    process.stdout.write(`The Neo4j tests run against the dev server, Neo4j ${version}\n`);
  } catch (error) {
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr).trim() : error instanceof Error ? error.message : '';
    // vitest cannot print an error thrown from a global setup (its handling of the stack fails), so the message is written here and the run ends
    process.stderr.write(`\nThe Neo4j tests cannot run: ${stderr === '' ? 'the check of the dev Neo4j server failed' : stderr}\n`);
    process.exit(1);
  }
}
