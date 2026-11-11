import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs, USAGE, type RunOptions } from './args.js';
import { logsFolderName, recordBaseName, writeRecord } from './record.js';
import { DATA_SECRET_ENV_NAMES, longEnough, SECRET_ENV_NAMES, secretValues } from './redact.js';
import { runChecks } from './runner.js';
import type { Check, Exec, RunEnvironment, RunRecord } from './types.js';

export const EXIT_PASSED = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

const UNAVAILABLE = 'unavailable';

export interface RunDeps {
  readonly exec: Exec;
  readonly signal: AbortSignal;
  readonly repoRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: () => Date;
  readonly monotonicNowMs: () => number;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly catalogue: (options: RunOptions) => readonly Check[];
  /** The address and the password to mask besides those of the environment, for example those read from the settings file. */
  readonly extraSecrets?: readonly string[];
  /** Login names to mask in logs and details, but not in recorded figures: a common name would garble them. */
  readonly extraLogins?: readonly string[];
}

async function firstLine(exec: Exec, command: string, args: readonly string[], cwd: string): Promise<string> {
  const result = await exec({ command, args, cwd });
  return result.exitCode === 0 ? (result.output.trim().split('\n')[0] ?? UNAVAILABLE) : UNAVAILABLE;
}

async function readEnvironment(exec: Exec, cwd: string): Promise<RunEnvironment> {
  return {
    node: process.version,
    pnpm: await firstLine(exec, 'pnpm', ['--version'], cwd),
    docker: await firstLine(exec, 'docker', ['version', '--format', '{{.Server.Version}}'], cwd),
  };
}

function isInside(folder: string, root: string): boolean {
  const path = relative(root, folder);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/** Returns the process exit code: 0 every check passed, 1 a check failed, 2 a usage error. */
export async function runRelease(argv: readonly string[], deps: RunDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.kind === 'usage-error') {
    deps.err(`${parsed.message}\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  const { dryRun } = parsed.options;
  const recordDir = resolve(deps.env['INIT_CWD'] ?? process.cwd(), parsed.options.recordDir);
  if (isInside(recordDir, deps.repoRoot)) {
    deps.err(`--record-dir must be a folder outside this repository\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  const commit = (await firstLine(deps.exec, 'git', ['rev-parse', 'HEAD'], deps.repoRoot));
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    deps.err('cannot read the commit of this checkout\n');
    return EXIT_USAGE;
  }
  const status = await deps.exec({ command: 'git', args: ['status', '--porcelain'], cwd: deps.repoRoot });
  const treeClean = status.exitCode === 0 && status.output.trim() === '';
  if (!dryRun && !treeClean) {
    deps.err('the working tree has uncommitted changes; commit them, or run with --dry-run\n');
    return EXIT_USAGE;
  }

  const startedAt = deps.clock();
  const base = recordBaseName(startedAt, commit, dryRun);
  const logsDir = join(recordDir, logsFolderName(base));
  const workDir = join(logsDir, 'work');
  await mkdir(workDir, { recursive: true });
  const environment = await readEnvironment(deps.exec, deps.repoRoot);
  const results = await runChecks(deps.catalogue(parsed.options), {
    context: { exec: deps.exec, signal: deps.signal, repoRoot: deps.repoRoot, commit, monotonicNowMs: deps.monotonicNowMs, workDir, env: deps.env },
    secrets: [...secretValues(deps.env, SECRET_ENV_NAMES), ...longEnough(deps.extraSecrets ?? []), ...longEnough(deps.extraLogins ?? [])],
    dataSecrets: [...secretValues(deps.env, DATA_SECRET_ENV_NAMES), ...longEnough(deps.extraSecrets ?? [])],
    monotonicNowMs: deps.monotonicNowMs,
    saveLog: async (checkId, text) => {
      await writeFile(join(logsDir, `${checkId}.log`), text);
      return join(logsFolderName(base), `${checkId}.log`);
    },
  });
  const record: RunRecord = { dryRun, result: results.every((result) => result.status === 'passed') ? 'PASS' : 'FAIL', startedAt: startedAt.toISOString(), finishedAt: deps.clock().toISOString(), commit, treeClean, environment, checks: results };
  const written = await writeRecord(recordDir, base, record);
  const failed = results.filter((result) => result.status === 'failed');
  deps.out(`${dryRun ? 'Dry run: does not count.\n' : ''}record: ${written.markdown}\n`);
  if (failed.length > 0) {
    deps.err(`failed: ${failed.map((result) => result.id).join(', ')}\n`);
    return EXIT_FAILED;
  }
  deps.out('every check passed\n');
  return EXIT_PASSED;
}
