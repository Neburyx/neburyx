import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { commandCheck, describeCommand, execFailure } from './command-check.js';
import { neo4jConnection } from './connection.js';
import { testsPassed } from './test-output.js';
import type { Check, CheckContext, CheckOutcome, ExecRequest } from './types.js';

/** The pass threshold of the supernode benchmark: the p95 of the paged expand must be under this at 100,000 relationships. */
export const P95_LIMIT_MS = 3000;
const BASELINE_SIZE = 100_000;
const LOWER_BOUND_FAILURE_SHARE = 20;
const BENCHMARK_FILES = 'docs/benchmarks';
const RECORD_FILE = 'supernode.json';

const reportSchema = z.object({
  date: z.string(),
  commit: z.string().optional(),
  neo4j: z.object({ version: z.string(), edition: z.string() }),
  cells: z.array(z.object({ size: z.number(), readSet: z.string(), position: z.string(), samples: z.number(), failures: z.number(), p95: z.number() })),
  stopped: z.array(z.object({ size: z.number(), readSet: z.string() })),
});

export type BenchmarkReport = z.infer<typeof reportSchema>;

export interface BenchmarkVerdict {
  readonly met: boolean;
  readonly worstP95Ms: number;
  readonly worst: { readonly readSet: string; readonly position: string };
  readonly overLimit: readonly { readonly readSet: string; readonly position: string; readonly p95: number }[];
  readonly lowerBound: readonly { readonly readSet: string; readonly position: string }[];
  readonly stopped: readonly string[];
}

/** The rule of the benchmark record: every cell at 100,000 under the limit, none resting on failed calls (a failed call's length is not its cost), no walk stopped early. */
export function judgeBenchmark(report: BenchmarkReport): BenchmarkVerdict | undefined {
  const baseline = report.cells.filter((cell) => cell.size === BASELINE_SIZE);
  const worst = baseline.reduce<(typeof baseline)[number] | undefined>((best, cell) => (best === undefined || cell.p95 > best.p95 ? cell : best), undefined);
  if (worst === undefined) return undefined;
  const overLimit = baseline.filter((cell) => cell.p95 >= P95_LIMIT_MS).map((cell) => ({ readSet: cell.readSet, position: cell.position, p95: cell.p95 }));
  const lowerBound = baseline.filter((cell) => cell.failures * LOWER_BOUND_FAILURE_SHARE > cell.samples).map((cell) => ({ readSet: cell.readSet, position: cell.position }));
  const stopped = report.stopped.filter((entry) => entry.size === BASELINE_SIZE).map((entry) => entry.readSet);
  return { met: overLimit.length === 0 && lowerBound.length === 0 && stopped.length === 0, worstP95Ms: worst.p95, worst: { readSet: worst.readSet, position: worst.position }, overLimit, lowerBound, stopped };
}

function hashFolder(folder: string): Readonly<Record<string, string>> {
  if (!existsSync(folder)) return {};
  return Object.fromEntries(readdirSync(folder).sort().map((name) => [name, createHash('sha256').update(readFileSync(join(folder, name))).digest('hex')]));
}

function readReport(file: string): BenchmarkReport | undefined {
  try {
    return reportSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

export function supernodeSuiteCheck(settingsFile?: string): Check {
  const request: ExecRequest = { command: 'pnpm', args: ['test:supernodes'] };
  const command = describeCommand(request);
  return {
    id: 'supernode-suite',
    name: 'Supernode suite (1k, 10k, 100k)',
    command,
    run: async (context: CheckContext): Promise<CheckOutcome> => {
      const connection = neo4jConnection(context.env, settingsFile);
      if (!connection.ok) return { status: 'failed', detail: connection.detail, command, exitCode: null, output: `${connection.detail}\n` };
      const recordFile = join(context.workDir, 'supernode-suite-record.json');
      const result = await context.exec({ ...request, cwd: context.repoRoot, env: { NBX_SUPERNODE_RECORD: recordFile } });
      const base = { command, exitCode: result.exitCode, output: result.output, data: { recordFile } };
      const failure = execFailure(result, undefined);
      if (failure !== undefined) return { ...base, status: 'failed', detail: failure };
      const passed = testsPassed(result.output);
      if (passed === undefined || passed < 1) return { ...base, status: 'failed', detail: 'no tests ran' };
      if (!existsSync(recordFile)) return { ...base, status: 'failed', detail: 'no suite record written' };
      return { ...base, status: 'passed', detail: `${passed} tests passed; record ${recordFile}` };
    },
  };
}

export function fuzzRealServerCheck(repoRoot: string, settingsFile?: string): Check {
  const inner = commandCheck({
    id: 'fuzz-real-server',
    name: 'Input fuzz on a real Neo4j test database',
    requests: [{ command: 'pnpm', args: ['--filter', '@neburyx/api', 'exec', 'vitest', 'run', '--config', 'vitest.neo4j.config.ts', 'src/fuzz/real-server.neo4j.test.ts'], cwd: repoRoot }],
    expectsTests: true,
  });
  return {
    ...inner,
    run: async (context) => {
      const connection = neo4jConnection(context.env, settingsFile);
      if (!connection.ok) return { status: 'failed', detail: connection.detail, command: inner.command, exitCode: null, output: `${connection.detail}\n` };
      return inner.run(context);
    },
  };
}

export function supernodeBenchmarkCheck(settingsFile?: string): Check {
  const request: ExecRequest = { command: 'pnpm', args: ['bench:supernode'] };
  const command = describeCommand(request);
  return {
    id: 'supernode-benchmark',
    name: 'Supernode benchmark (p95 expand under 3 s)',
    command,
    run: async (context: CheckContext): Promise<CheckOutcome> => {
      const connection = neo4jConnection(context.env, settingsFile);
      if (!connection.ok) return { status: 'failed', detail: connection.detail, command, exitCode: null, output: `${connection.detail}\n` };
      const committed = join(context.repoRoot, BENCHMARK_FILES);
      const before = hashFolder(committed);
      const recordDir = join(context.workDir, 'benchmark');
      const result = await context.exec({ ...request, cwd: context.repoRoot, env: { NBX_BENCH_RECORD_DIR: recordDir } });
      const unchanged = JSON.stringify(before) === JSON.stringify(hashFolder(committed));
      const report = readReport(join(recordDir, RECORD_FILE));
      const verdict = report === undefined ? undefined : judgeBenchmark(report);
      const figures = report === undefined ? undefined : { ...(verdict ?? {}), limitMs: P95_LIMIT_MS, neo4j: report.neo4j, commit: report.commit ?? null, date: report.date, recordDir };
      const base = { command, exitCode: result.exitCode, output: result.output, data: { ...figures, committedRecordUnchanged: unchanged } };
      const failure = execFailure(result, undefined);
      if (failure !== undefined) return { ...base, status: 'failed', detail: failure };
      if (!unchanged) return { ...base, status: 'failed', detail: `the files of ${BENCHMARK_FILES} changed during the run` };
      if (verdict === undefined) return { ...base, status: 'failed', detail: 'no benchmark record' };
      const worst = `worst p95 ${Math.round(verdict.worstP95Ms)} ms (${verdict.worst.readSet}, ${verdict.worst.position}), limit ${P95_LIMIT_MS} ms`;
      if (verdict.met) return { ...base, status: 'passed', detail: worst };
      const reasons = [
        ...verdict.overLimit.map((cell) => `over the limit: ${cell.readSet}, ${cell.position}, ${Math.round(cell.p95)} ms`),
        ...verdict.lowerBound.map((cell) => `rests on failed calls: ${cell.readSet}, ${cell.position}`),
        ...verdict.stopped.map((readSet) => `stopped early: ${readSet}`),
      ];
      return { ...base, status: 'failed', detail: `${worst}; ${reasons.join('; ')}` };
    },
  };
}
