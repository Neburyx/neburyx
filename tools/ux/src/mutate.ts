import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isStopping, runTracked, stopTracked } from './children.ts';
import { restoreOnInterrupt } from './interrupt.ts';
import { checkBrokenBinding, type TestRun } from './mutation.ts';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const WEB = (path: string): string => fileURLToPath(new URL(`../../../apps/web/src/${path}`, import.meta.url));

/** One thing to break in the app, and the browser test that has to notice. */
interface Mutation {
  readonly name: string;
  readonly source: string;
  readonly binding: string;
  readonly broken: string;
  /** What the broken app is, for the line that reports the check. */
  readonly what: string;
  readonly test: { readonly file: string; readonly title: string; readonly project: string; readonly env: Readonly<Record<string, string>>; readonly extraArgs: readonly string[] };
  readonly assertion: RegExp;
}

/** Stops the page for this long, by the clock and not by the CPU, so the throttle of the test cannot hide it. */
const stall = (ms: number): string => `{ const until = performance.now() + ${ms}; while (performance.now() < until) { /* the mutation: a stall */ } }`;

const MUTATIONS: readonly Mutation[] = [
  {
    name: 'keyboard',
    source: WEB('workspace/built-in-key-bindings.ts'),
    binding: "keys: ['l']",
    broken: "keys: ['y']",
    what: 'with the Legend binding broken',
    test: { file: 'tests/keyboard-workspace.spec.ts', title: 'choose the tools, open and close the legend, and fit the view, with the platform modifier', project: 'laptop-1440', env: {}, extraArgs: [] },
    assertion: /toBe\(expected\)|Expected: true/,
  },
  {
    // the crossing of the caption limit given a 400 ms stall, against the runner's limit of 300 ms (the runner profile selects it)
    name: 'crossing',
    source: WEB('canvas/cytoscape-renderer.ts'),
    binding: '    if (farQueue.length === 0) return;\n    if (immediate) classifyFar',
    broken: `    ${stall(400)}\n    if (farQueue.length === 0) return;\n    if (immediate) classifyFar`,
    what: 'with a 400 ms stall in every pass of the far-view switch, held to the runner limit',
    test: { file: 'tests/zoomed-out.spec.ts', title: 'switches without a frame longer than', project: 'laptop-1440', env: { NEBURYX_UX_PROFILE: 'runner' }, extraArgs: [] },
    assertion: /toBeLessThanOrEqual/,
  },
  {
    // the pan and zoom of the 300-element canvas given a 25 ms stall at every pan, zoom and grab
    name: 'benchmark',
    source: WEB('canvas/cytoscape-renderer.ts'),
    binding: "created.on('pan zoom grab', dropTip);",
    broken: `created.on('pan zoom grab', () => ${stall(25)});\n      created.on('pan zoom grab', dropTip);`,
    what: 'with a 25 ms stall at every pan and zoom, held to the runner threshold',
    test: { file: 'tests/benchmark.spec.ts', title: 'holds the threshold', project: 'benchmark', env: { NEBURYX_UX_PROFILE: 'runner' }, extraArgs: ['--no-deps'] },
    assertion: /toEqual\(expected\)/,
  },
  {
    // the shared look of selectors and text fields taken out of the built CSS: the source selector and the search box fall back to the browser's look
    name: 'default-look',
    source: WEB('styles/controls.css'),
    binding: "    select:not([class]),\n    select[class=''],\n    input:not([class]):is(:not([type]), [type='text'], [type='search']),\n    input[class='']:is(:not([type]), [type='text'], [type='search'])\n  ),\nbutton.primary,",
    broken: "    button[class='']\n  ),\nbutton.primary,",
    what: "with the shared look of selectors and text fields taken out, so the source selector and the search box have the browser's look",
    test: { file: 'tests/default-look.spec.ts', title: "no product page or state has a control with the browser's default look", project: 'laptop-1440', env: {}, extraArgs: [] },
    assertion: /toEqual\(expected\)/,
  },
];
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

async function runTest(mutation: Mutation): Promise<TestRun> {
  const { file, title, project, env, extraArgs } = mutation.test;
  const { stdout, stderr, code, signal } = await runTracked('pnpm', ['exec', 'playwright', 'test', file, '-g', title, `--project=${project}`, ...extraArgs, '--reporter=json'], PACKAGE, env);
  const run = readRun(stdout, code, signal);
  return run.errors.length > 0 && stderr.trim() !== '' ? { ...run, errors: [...run.errors, `its error output ended: ${stderr.trim().slice(-300)}`] } : run;
}

const buildSync = (): void => void execFileSync('pnpm', ['--filter', '@neburyx/web', 'build:ux'], { cwd: ROOT, stdio: 'ignore' });

/** The mutation being checked and what the source was before it, so that an interrupt can put it back. */
let current: { readonly source: string; readonly original: string } | undefined;

async function check(mutation: Mutation): Promise<void> {
  const original = readFileSync(mutation.source, 'utf8');
  if (!original.includes(mutation.binding)) throw new Error(`MUTATION_BINDING_NOT_FOUND: ${mutation.name}`);
  current = { source: mutation.source, original };
  try {
    const outcome = await checkBrokenBinding({
      run: () => runTest(mutation),
      breakBinding: async () => {
        writeFileSync(mutation.source, original.replace(mutation.binding, mutation.broken));
        buildSync();
      },
      restore: async () => {
        writeFileSync(mutation.source, original);
        buildSync();
      },
      expected: { title: mutation.test.title, assertion: mutation.assertion },
    });
    process.stdout.write(`The ${mutation.name} test passed, failed on its assertion ${mutation.what} ("${outcome.broken.failures[0]?.message.split('\n')[0] ?? ''}"), and passed again once it was restored.\n`);
  } catch (error) {
    writeFileSync(mutation.source, original);
    // an interrupt is being handled: it restores, builds and leaves with its own code, so the check does not leave first with an error of a run it stopped
    if (isStopping()) await new Promise<never>(() => undefined);
    throw error;
  } finally {
    current = undefined;
  }
}

async function main(): Promise<void> {
  const wanted = process.argv.slice(2);
  const chosen = wanted.length === 0 ? MUTATIONS : MUTATIONS.filter((mutation) => wanted.includes(mutation.name));
  if (chosen.length === 0) throw new Error(`MUTATION_UNKNOWN: ${wanted.join(', ')}; the checks are ${MUTATIONS.map((mutation) => mutation.name).join(', ')}`);
  restoreOnInterrupt(process, {
    stopChildren: stopTracked,
    restoreSource: () => (current === undefined ? undefined : writeFileSync(current.source, current.original)),
    rebuild: buildSync,
    exit: (code) => process.exit(code),
    report: (error) => void process.stderr.write(`interrupt: ${error instanceof Error ? error.message : String(error)}\n`),
  });
  for (const mutation of chosen) await check(mutation);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
