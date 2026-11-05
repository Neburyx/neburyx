import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runTracked, stopTracked } from './children.ts';
import { restoreOnInterrupt } from './interrupt.ts';
import { checkBrokenBinding, type TestRun } from './mutation.ts';

const SOURCE = fileURLToPath(new URL('../../../apps/web/src/workspace/built-in-key-bindings.ts', import.meta.url));
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TEST = 'choose the tools, open and close the legend, and fit the view, with the platform modifier';
const BINDING = "keys: ['l']";
const BROKEN = "keys: ['y']";
const ANSI = /\u001b\[[0-9;]*m/g;

interface Spec {
  readonly title: string;
  readonly tests: ReadonlyArray<{ readonly results: ReadonlyArray<{ readonly status: string; readonly error?: { readonly message?: string } }> }>;
}
interface Suite {
  readonly specs?: readonly Spec[];
  readonly suites?: readonly Suite[];
}
interface Report extends Suite {
  readonly errors?: ReadonlyArray<{ readonly message?: string }>;
  readonly stats?: { readonly expected?: number; readonly unexpected?: number; readonly flaky?: number };
}

function failuresOf(suite: Suite): TestRun['failures'] {
  const own = (suite.specs ?? []).flatMap((spec) =>
    spec.tests.flatMap((test) => test.results.filter((result) => result.status === 'failed' || result.status === 'timedOut').map((result) => ({ title: spec.title, message: (result.error?.message ?? '').replace(ANSI, '') }))),
  );
  return [...own, ...(suite.suites ?? []).flatMap(failuresOf)];
}

function resultsOf(suite: Suite): Array<{ readonly status: string }> {
  const own = (suite.specs ?? []).flatMap((spec) => spec.tests.map((test) => test.results.at(-1) ?? { status: 'none' }));
  return [...own, ...(suite.suites ?? []).flatMap(resultsOf)];
}

/** What a run of the test says, with everything outside the tests kept: the runner's own errors, a process that a signal ended or that ended in a way its report does not show, a report whose count is not what its tests show, and no report at all. The tests that passed are counted from the results themselves. */
export function readRun(stdout: string, code: number | null, signal: NodeJS.Signals | null = null): TestRun {
  let report: Report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return { failures: [], errors: [`the test runner gave no report (it ended with ${signal ?? String(code)})`], passed: 0 };
  }
  const failures = failuresOf(report);
  const errors = (report.errors ?? []).map((error) => (error.message ?? 'an error of the runner').replace(ANSI, '').split('\n')[0] ?? '');
  const passed = resultsOf(report).filter((result) => result.status === 'passed').length;
  if (signal !== null) errors.push(`the test runner was ended by ${signal}`);
  if (code === 0 && failures.length > 0) errors.push('the test runner ended with 0 although a test failed');
  if (code !== 0 && signal === null && failures.length === 0 && errors.length === 0) errors.push(`the test runner ended with ${String(code)} and no failed test`);
  if (report.stats?.expected !== undefined && report.stats.expected !== passed) errors.push(`the report counts ${report.stats.expected} passed tests and shows ${passed}`);
  if ((report.stats?.flaky ?? 0) > 0) errors.push('a test passed only on a retry');
  return { failures, errors, passed };
}

async function runKeyboardTest(): Promise<TestRun> {
  const { stdout, stderr, code, signal } = await runTracked('pnpm', ['exec', 'playwright', 'test', 'tests/keyboard-workspace.spec.ts', '-g', TEST, '--project=laptop-1440', '--reporter=json'], PACKAGE);
  const run = readRun(stdout, code, signal);
  return run.errors.length > 0 && stderr.trim() !== '' ? { ...run, errors: [...run.errors, `its error output ended: ${stderr.trim().slice(-300)}`] } : run;
}

const buildSync = (): void => void execFileSync('pnpm', ['--filter', '@neburyx/web', 'build:ux'], { cwd: ROOT, stdio: 'ignore' });

async function main(): Promise<void> {
  const original = readFileSync(SOURCE, 'utf8');
  if (!original.includes(BINDING)) throw new Error('MUTATION_BINDING_NOT_FOUND');
  restoreOnInterrupt(process, {
    stopChildren: stopTracked,
    restoreSource: () => writeFileSync(SOURCE, original),
    rebuild: buildSync,
    exit: (code) => process.exit(code),
    report: (error) => void process.stderr.write(`interrupt: ${error instanceof Error ? error.message : String(error)}\n`),
  });
  try {
    const outcome = await checkBrokenBinding({
      run: runKeyboardTest,
      breakBinding: async () => {
        writeFileSync(SOURCE, original.replace(BINDING, BROKEN));
        buildSync();
      },
      restore: async () => {
        writeFileSync(SOURCE, original);
        buildSync();
      },
      expected: { title: TEST, assertion: /toBe\(expected\)|Expected: true/ },
    });
    process.stdout.write(`The keyboard test passed, failed on its assertion with the Legend binding broken ("${outcome.broken.failures[0]?.message.split('\n')[0] ?? ''}"), and passed again once it was restored.\n`);
  } catch (error) {
    writeFileSync(SOURCE, original);
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
