import { ExperimentError } from './errors.js';
import { runAll } from './experiments.js';
import { neo4jBackend } from './neo4j-backend.js';
import { bounded } from './probe.js';
import { renderReport } from './report.js';
import { startContainer, type Server, type StartServer } from './server.js';
import type { Findings } from './types.js';

export const DEFAULT_IMAGES: readonly string[] = ['neo4j:5.26', 'neo4j:2026'];
export const USAGE = 'usage: check [--image <name>]...   (default images: neo4j:5.26 and neo4j:2026)';

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export interface Deps {
  readonly start: StartServer;
  readonly execute: (server: Server) => Promise<Findings>;
}

export const realDeps: Deps = { start: startContainer, execute: (server) => runAll(neo4jBackend(server), server.image) };

export type Parsed = { readonly images: readonly string[] } | { readonly error: string };

export function parseArgs(argv: readonly string[]): Parsed {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const images: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== '--image') return { error: `unknown argument: ${arg}` };
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) return { error: '--image needs a value' };
    images.push(value);
    i++;
  }
  return { images: images.length > 0 ? images : DEFAULT_IMAGES };
}

async function stopServer(server: Server | undefined, image: string, failures: string[]): Promise<void> {
  if (!server) return;
  try {
    await bounded(`stopping the container of ${image}`, server.stop());
  } catch (error) {
    failures.push(`the container of ${image} may still be running: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Prints the report only when every image ran. A failure to run prints a message on the error stream and
 * nothing else (exit 1). A report whose cleanup failed is printed, with the problems on the error stream (exit 2).
 */
export async function runCheck(images: readonly string[], io: Io, deps: Deps): Promise<number> {
  const all: Findings[] = [];
  const stopFailures: string[] = [];
  for (const image of images) {
    let server: Server | undefined;
    try {
      server = await deps.start(image);
      all.push(await deps.execute(server));
    } catch (error) {
      await stopServer(server, image, stopFailures);
      io.err(`the check could not run on ${image}: ${error instanceof Error ? error.message : String(error)}`);
      const problems = [
        ...all.flatMap((findings) => findings.cleanupFailures),
        ...(error instanceof ExperimentError ? error.cleanupFailures : []),
        ...stopFailures,
      ];
      for (const problem of problems) io.err(`cleanup problem: ${problem}`);
      return 1;
    }
    await stopServer(server, image, stopFailures);
  }
  io.out(renderReport(all, stopFailures));
  const problems = [...all.flatMap((findings) => findings.cleanupFailures), ...stopFailures];
  for (const problem of problems) io.err(`cleanup problem: ${problem}`);
  return problems.length > 0 ? 2 : 0;
}
