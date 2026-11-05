import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { restoreOnInterrupt } from './interrupt.ts';
import { checkBrokenBinding, type TestRun } from './mutation.ts';

const SOURCE = fileURLToPath(new URL('../../../apps/web/src/workspace/built-in-key-bindings.ts', import.meta.url));
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TEST = 'choose the tools, open and close the legend, and fit the view, with the platform modifier';
const BINDING = "keys: ['l']";
const BROKEN = "keys: ['y']";
const ANSI = /\u001b\[[0-9;]*m/g;

const running = new Set<ChildProcess>();

/** Runs a command to its end and gives its output and how it ended; what is running is kept, so that an interrupt can stop it. */
function run(command: string, args: readonly string[], cwd: string): Promise<{ readonly stdout: string; readonly code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    const out: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => void out.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      running.delete(child);
      resolve({ stdout: Buffer.concat(out).toString('utf8'), code });
    });
  });
}

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

/** What a run of the test says, with everything outside the tests kept: the runner's own errors, and a process that ended with a failure while every test passed or with no report at all. */
export function readRun(stdout: string, code: number | null): TestRun {
  let report: Report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return { failures: [], errors: [`the test runner gave no report (it ended with ${String(code)})`], passed: 0 };
  }
  const failures = failuresOf(report);
  const errors = (report.errors ?? []).map((error) => (error.message ?? 'an error of the runner').replace(ANSI, '').split('\n')[0] ?? '');
  const expected = report.stats?.expected ?? 0;
  if (code !== 0 && failures.length === 0 && errors.length === 0) errors.push(`the test runner ended with ${String(code)} and no failed test`);
  if ((report.stats?.flaky ?? 0) > 0) errors.push('a test passed only on a retry');
  return { failures, errors, passed: expected };
}

async function runKeyboardTest(): Promise<TestRun> {
  const { stdout, code } = await run('pnpm', ['exec', 'playwright', 'test', 'tests/keyboard-workspace.spec.ts', '-g', TEST, '--project=laptop-1440', '--reporter=json'], PACKAGE);
  return readRun(stdout, code);
}

const buildSync = (): void => void execFileSync('pnpm', ['--filter', '@neburyx/web', 'build:ux'], { cwd: ROOT, stdio: 'ignore' });

async function main(): Promise<void> {
  const original = readFileSync(SOURCE, 'utf8');
  if (!original.includes(BINDING)) throw new Error('MUTATION_BINDING_NOT_FOUND');
  restoreOnInterrupt(process, {
    stopChildren: () => running.forEach((child) => child.kill('SIGKILL')),
    restoreSource: () => writeFileSync(SOURCE, original),
    rebuild: buildSync,
    exit: (code) => process.exit(code),
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
