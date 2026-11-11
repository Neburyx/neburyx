import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { describeCommand, execFailure } from './command-check.js';
import type { CheckContext, ExecRequest } from './types.js';

const reportSchema = z.object({
  testResults: z.array(z.object({ assertionResults: z.array(z.object({ title: z.string(), fullName: z.string(), status: z.string() })) })),
});

export interface RequiredTest {
  /** The start of the test's title. */
  readonly title: string;
  /** The least number of passed tests that must start with the title. */
  readonly atLeast: number;
}

export interface VitestRun {
  readonly label: string;
  readonly package: string;
  readonly args: readonly string[];
  readonly needsDocker: boolean;
  readonly required: readonly RequiredTest[];
}

export interface VitestRunResult {
  readonly label: string;
  readonly status: 'passed' | 'failed';
  readonly detail: string;
  readonly command: string;
  readonly exitCode: number | null;
  readonly output: string;
  readonly passed: number;
}

export const DOCKER_UNREACHABLE = 'Docker is not reachable';

export async function dockerReachable(context: CheckContext): Promise<boolean> {
  const result = await context.exec({ command: 'docker', args: ['info', '--format', '{{.ServerVersion}}'], cwd: context.repoRoot });
  return result.exitCode === 0;
}

function request(context: CheckContext, run: VitestRun, reportFile: string): ExecRequest {
  const args = ['--filter', run.package, 'exec', 'vitest', 'run', ...run.args, '--reporter=default', '--reporter=json', `--outputFile.json=${reportFile}`];
  return { command: 'pnpm', args, cwd: context.repoRoot };
}

async function readPassedTitles(reportFile: string): Promise<readonly string[] | undefined> {
  try {
    const report = reportSchema.parse(JSON.parse(await readFile(reportFile, 'utf8')));
    return report.testResults.flatMap((file) => file.assertionResults.filter((test) => test.status === 'passed').map((test) => test.title));
  } catch {
    return undefined;
  }
}

function missingRequired(run: VitestRun, titles: readonly string[]): string | undefined {
  for (const required of run.required) {
    const found = titles.filter((title) => title.startsWith(required.title)).length;
    if (found < required.atLeast) return `required test not found ${required.atLeast} time(s), found ${found}: ${required.title}`;
  }
  return undefined;
}

/** Runs one vitest command and judges it by its JSON report, not by the exit code alone. */
export async function runVitest(context: CheckContext, run: VitestRun, dockerUp: boolean): Promise<VitestRunResult> {
  const reportFile = join(context.workDir, `${run.label}.json`);
  const spec = request(context, run, reportFile);
  const base = { label: run.label, command: describeCommand(spec) };
  if (run.needsDocker && !dockerUp) return { ...base, status: 'failed', detail: DOCKER_UNREACHABLE, exitCode: null, output: `${DOCKER_UNREACHABLE}\n`, passed: 0 };
  const result = await context.exec(spec);
  const failure = execFailure(result, undefined);
  if (failure !== undefined) return { ...base, status: 'failed', detail: failure, exitCode: result.exitCode, output: result.output, passed: 0 };
  const titles = await readPassedTitles(reportFile);
  if (titles === undefined) return { ...base, status: 'failed', detail: 'no test report', exitCode: result.exitCode, output: result.output, passed: 0 };
  if (titles.length === 0) return { ...base, status: 'failed', detail: 'no tests ran', exitCode: result.exitCode, output: result.output, passed: 0 };
  const missing = missingRequired(run, titles);
  if (missing !== undefined) return { ...base, status: 'failed', detail: missing, exitCode: result.exitCode, output: result.output, passed: titles.length };
  return { ...base, status: 'passed', detail: `${titles.length} tests passed`, exitCode: result.exitCode, output: result.output, passed: titles.length };
}
