import { join, relative } from 'node:path';
import { z } from 'zod';
import { describeCommand, execFailure } from './command-check.js';
import { builtOnce } from './suite-build.js';
import type { Files } from './files.js';
import type { CheckContext, ExecRequest } from './types.js';
import { wordsPattern, type NamedRow } from './named-tests.js';

export interface SuiteFiles extends Files {
  readonly packageOf: (path: string) => Promise<{ readonly name: string; readonly root: string }>;
}

const reportSchema = z.object({
  numFailedTests: z.number().optional(),
  testResults: z.array(z.object({ name: z.string(), assertionResults: z.array(z.object({ title: z.string(), fullName: z.string(), status: z.string() })) })),
});

interface ReportedTest {
  readonly file: string;
  readonly title: string;
  readonly fullName: string;
  readonly status: string;
}

export interface SuiteRun {
  readonly ok: boolean;
  readonly detail: string;
  readonly command: string;
  readonly exitCode: number | null;
  readonly output: string;
  readonly tests: readonly ReportedTest[];
}

export async function runPackage(context: CheckContext, files: SuiteFiles, spec: { readonly label: string; readonly package: string; readonly args: readonly string[]; readonly env?: Readonly<Record<string, string>> }): Promise<SuiteRun> {
  const built = await builtOnce(context);
  if (!built.ok) return { ok: false, detail: built.detail, command: built.command, exitCode: built.exitCode, output: built.output, tests: [] };
  const reportFile = join(context.workDir, `${spec.label}.json`);
  const request: ExecRequest = { command: 'pnpm', args: ['--filter', spec.package, 'exec', 'vitest', 'run', ...spec.args, '--reporter=default', '--reporter=json', `--outputFile.json=${reportFile}`], cwd: context.repoRoot, ...(spec.env === undefined ? {} : { env: spec.env }) };
  const command = describeCommand(request);
  const result = await context.exec(request);
  const failure = execFailure(result, undefined);
  const base = { command, exitCode: result.exitCode, output: result.output };
  if (failure !== undefined) return { ...base, ok: false, detail: failure, tests: [] };
  let report: z.infer<typeof reportSchema>;
  try {
    report = reportSchema.parse(JSON.parse(await files.readText(reportFile)));
  } catch {
    return { ...base, ok: false, detail: 'no test report', tests: [] };
  }
  const tests = report.testResults.flatMap((file) => file.assertionResults.map((test) => ({ file: file.name, title: test.title, fullName: test.fullName, status: test.status })));
  const notPassed = tests.filter((test) => test.status !== 'passed' && test.status !== 'skipped');
  if (notPassed.length > 0) return { ...base, ok: false, detail: `${notPassed.length} tests did not pass in ${spec.package}`, tests };
  if (tests.filter((test) => test.status === 'passed').length === 0) return { ...base, ok: false, detail: `no tests ran in ${spec.package}`, tests };
  return { ...base, ok: true, detail: `${tests.filter((test) => test.status === 'passed').length} tests passed in ${spec.package}`, tests };
}

/** The rows of a table whose test is not among the passed tests of its file in the runs; a file is found by its path in the repository, however the runner spelled the folders above it. */
export function rowsNotFound(rows: readonly (NamedRow & { readonly absolute: string })[], runs: readonly SuiteRun[], repoRoot: string): readonly NamedRow[] {
  const passed = runs.flatMap((run) => run.tests.filter((test) => test.status === 'passed'));
  return rows.filter((row) => {
    const pattern = wordsPattern(row.title);
    const inRepository = `/${relative(repoRoot, row.absolute)}`;
    return !passed.some((test) => (test.file === row.absolute || test.file.endsWith(inRepository)) && (pattern.test(test.title) || pattern.test(test.fullName)));
  });
}
