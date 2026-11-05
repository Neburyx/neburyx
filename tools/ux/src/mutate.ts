import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checkBrokenBinding, type TestRun } from './mutation.ts';

const run = promisify(execFile);
const SOURCE = fileURLToPath(new URL('../../../apps/web/src/workspace/built-in-key-bindings.ts', import.meta.url));
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TEST = 'choose the tools, open and close the legend, and fit the view, with the platform modifier';
const BINDING = "keys: ['l']";
const BROKEN = "keys: ['y']";

interface Spec {
  readonly title: string;
  readonly tests: ReadonlyArray<{ readonly results: ReadonlyArray<{ readonly status: string; readonly error?: { readonly message?: string } }> }>;
}
interface Suite {
  readonly specs?: readonly Spec[];
  readonly suites?: readonly Suite[];
}

function failuresOf(suite: Suite): TestRun['failures'] {
  const own = (suite.specs ?? []).flatMap((spec) =>
    spec.tests.flatMap((test) => test.results.filter((result) => result.status === 'failed' || result.status === 'timedOut').map((result) => ({ title: spec.title, message: (result.error?.message ?? '').replace(/\u001b\[[0-9;]*m/g, '') }))),
  );
  return [...own, ...(suite.suites ?? []).flatMap(failuresOf)];
}

async function runKeyboardTest(): Promise<TestRun> {
  const reply = await run('pnpm', ['exec', 'playwright', 'test', 'tests/keyboard-workspace.spec.ts', '-g', TEST, '--project=laptop-1440', '--reporter=json'], { cwd: PACKAGE, maxBuffer: 64 * 1024 * 1024 }).catch((error: { stdout?: string }) => error);
  const text = 'stdout' in reply && typeof reply.stdout === 'string' ? reply.stdout : '';
  const report: Suite & { readonly stats?: { readonly expected?: number; readonly unexpected?: number } } = JSON.parse(text);
  if ((report.stats?.expected ?? 0) + (report.stats?.unexpected ?? 0) === 0) throw new Error('MUTATION_NO_TEST_RAN');
  return { failures: failuresOf(report) };
}

const build = async (): Promise<void> => void (await run('pnpm', ['--filter', '@neburyx/web', 'build:ux'], { cwd: ROOT }));

const original = readFileSync(SOURCE, 'utf8');
if (!original.includes(BINDING)) throw new Error('MUTATION_BINDING_NOT_FOUND');
let restored = false;
const restore = async (): Promise<void> => {
  if (restored) return;
  writeFileSync(SOURCE, original);
  await build();
  restored = true;
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    writeFileSync(SOURCE, original);
    process.exit(1);
  });
}

try {
  const outcome = await checkBrokenBinding({
    run: runKeyboardTest,
    breakBinding: async () => {
      restored = false;
      writeFileSync(SOURCE, original.replace(BINDING, BROKEN));
      await build();
    },
    restore,
    expected: { title: TEST, assertion: /toBe\(expected\)|Expected: true/ },
  });
  process.stdout.write(`The keyboard test passed, failed on its assertion with the Legend binding broken ("${outcome.broken.failures[0]?.message.split('\n')[0] ?? ''}"), and passed again once it was restored.\n`);
} catch (error) {
  writeFileSync(SOURCE, original);
  throw error;
}
