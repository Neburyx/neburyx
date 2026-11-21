import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { askCitedSummaryCheck, askSafetyCheck, askSafetyReadTransactionCheck } from './ask-safety.js';
import type { SuiteFiles } from './suite-run.js';
import { execResult, fakeExec, testContext } from './testing.js';
import type { CheckContext, ExecRequest, ExecResult } from './types.js';

const NO_FILE = '/no-such-settings-file.env';
const CONNECTION = { NBX_EE_URI: 'bolt://neo4j.example:7687', NBX_EE_USER: 'reader', NBX_EE_PASSWORD: 'pw-for-test' };
const OWN = '/repo/tools/ask-safety-suite';
const G1 = 'a follow-up resolves only to an element the application gave, or asks';
const G2 = 'a turn stops at each of its limits';

const row = (guarantee: string, kind: string, file: string, title: string): string => `| What it proves | ${guarantee} | ${kind} | \`${file}\` | ${title} |`;
const README = (...rows: string[]): string => ['# suite', '', '## Named tests', '', '| What it proves | Guarantee | Kind | File | Test |', '|---|---|---|---|---|', ...rows, ''].join('\n');
const passed = (title: string, status = 'passed') => ({ title, fullName: title, status });
const report = (...files: { name: string; tests: ReturnType<typeof passed>[] }[]): string => JSON.stringify({ testResults: files.map((file) => ({ name: file.name, assertionResults: file.tests })) });

interface Setup {
  readonly readme: string;
  /** The report each run writes, by the label of the run (the name of the file in the work folder). */
  readonly reports: Record<string, string>;
  readonly exit?: (request: ExecRequest) => ExecResult;
}

function suites(setup: Setup) {
  const fake = fakeExec(setup.exit ?? (() => execResult()));
  const files: SuiteFiles = {
    readText: (path) => {
      if (path === join(OWN, 'README.md')) return Promise.resolve(setup.readme);
      const label = path.split('/').at(-1)?.replace(/\.json$/, '') ?? '';
      const found = setup.reports[label];
      return found === undefined ? Promise.reject(new Error('no such file')) : Promise.resolve(found);
    },
    folders: () => Promise.resolve([]),
    packageOf: (path) => Promise.resolve(path.startsWith(OWN) ? { name: '@neburyx/ask-safety-suite', root: OWN } : path.startsWith('/repo/ee/ask') ? { name: '@neburyx/ee-ask', root: '/repo/ee/ask' } : { name: '@neburyx/other', root: '/repo/other' }),
  };
  const context: CheckContext = { ...testContext(fake.exec), workDir: '/work' };
  return { fake, files, context };
}

const ROWS = [
  row(G1, 'real application', 'src/a.test.ts', 'runs nothing for'),
  row(G2, 'route rig', '../../ee/ask/src/x.test.ts', 'stops at the steps setting'),
  row('the Ask route', 'real application, not in CI', 'src/b.neo4j.test.ts', 'is refused by the explicit'),
];
const OWN_REPORT = report({ name: `${OWN}/src/a.test.ts`, tests: [passed('runs nothing for an invented key'), passed('another')] });
const EE_REPORT = report({ name: '/repo/ee/ask/src/x.test.ts', tests: [passed('stops at the steps setting: no more reads than steps')] });
const GOOD: Setup = { readme: README(...ROWS), reports: { 'ask-safety-suite': OWN_REPORT, 'named--neburyx-ee-ask': EE_REPORT } };

describe('the check of the Ask safety suite and the tests its table names (C2)', () => {
  const run = async (setup: Setup) => {
    const { fake, files, context } = suites(setup);
    return { outcome: await askSafetyCheck(files).run(context), requests: fake.requests };
  };

  it('runs the suite whole and the files its table names in their own packages, leaves a test that CI does not run to its own check, and passes with its figures', async () => {
    const { outcome, requests } = await run(GOOD);
    expect(outcome).toMatchObject({ status: 'passed' });
    expect(outcome.data).toMatchObject({ tests: 3, rows: 2, guarantees: 2 });
    expect(requests.map((request) => request.args.slice(0, 4))).toEqual([['--filter', '@neburyx/ask-safety-suite', 'exec', 'vitest'], ['--filter', '@neburyx/ee-ask', 'exec', 'vitest']]);
    expect(requests[1]?.args).toContain('src/x.test.ts');
    expect(requests.flatMap((request) => request.args).join(' ')).not.toContain('neo4j');
  });

  it('finds a row whose words are in the middle of a title and an it.each row with %s', async () => {
    const readme = README(row(G1, 'real application', 'src/a.test.ts', 'for an invented'), row(G2, 'real application', 'src/a.test.ts', 'refuses a start for %s, naming'));
    const reports = { 'ask-safety-suite': report({ name: `${OWN}/src/a.test.ts`, tests: [passed('runs nothing for an invented key'), passed('refuses a start for a write, naming the file')] }) };
    expect((await run({ readme, reports })).outcome.status).toBe('passed');
  });

  it('fails a test that failed, with no further run', async () => {
    const { outcome, requests } = await run({ ...GOOD, reports: { ...GOOD.reports, 'ask-safety-suite': report({ name: `${OWN}/src/a.test.ts`, tests: [passed('runs nothing for', 'failed')] }) } });
    expect(outcome).toMatchObject({ status: 'failed', detail: '1 tests did not pass in @neburyx/ask-safety-suite' });
    expect(requests).toHaveLength(1);
  });

  it('fails a row whose test is missing, and a row whose file ran but has no matching passed test', async () => {
    const missing = await run({ ...GOOD, reports: { ...GOOD.reports, 'named--neburyx-ee-ask': report({ name: '/repo/ee/ask/src/x.test.ts', tests: [passed('something else')] }) } });
    expect(missing.outcome.detail).toContain('1 named tests were not found among the passed tests, first: ../../ee/ask/src/x.test.ts');
    const none = await run({ ...GOOD, reports: { ...GOOD.reports, 'named--neburyx-ee-ask': report() } });
    expect(none.outcome).toMatchObject({ status: 'failed', detail: 'no tests ran in @neburyx/ee-ask' });
  });

  it('fails a skipped test as not found, a run with no report and a run that ended with an exit code', async () => {
    const skipped = await run({ ...GOOD, reports: { ...GOOD.reports, 'named--neburyx-ee-ask': report({ name: '/repo/ee/ask/src/x.test.ts', tests: [passed('stops at the steps setting', 'skipped'), passed('another')] }) } });
    expect(skipped.outcome.detail).toContain('named tests were not found');
    expect((await run({ ...GOOD, reports: {} })).outcome.detail).toBe('no test report');
    expect((await run({ ...GOOD, exit: () => execResult({ exitCode: 1 }) })).outcome.detail).toBe('exited with code 1');
  });

  it('fails a guarantee of the assistant whose only row is one that CI does not run, and a table with no row', async () => {
    const readme = README(row(G1, 'real application', 'src/a.test.ts', 'runs nothing for'), row(G2, 'real application, not in CI', 'src/b.neo4j.test.ts', 'only here'));
    expect((await run({ readme, reports: { 'ask-safety-suite': OWN_REPORT } })).outcome.detail).toContain(`a guarantee of the assistant has no passed row: ${G2}`);
    expect((await run({ readme: '# nothing\n', reports: {} })).outcome.detail).toBe('the table of named tests holds no row');
  });
});

describe('the Neo4j checks of C2 and C3', () => {
  const connected = (reports: Record<string, string>, exit?: (request: ExecRequest) => ExecResult) => {
    const { fake, files, context } = suites({ readme: '', reports, ...(exit === undefined ? {} : { exit }) });
    return { fake, files, context: { ...context, env: CONNECTION } as CheckContext };
  };
  const TRANSACTION = report({ name: `${OWN}/src/file-query-transaction.neo4j.test.ts`, tests: [passed('is refused by the explicit READ transaction on a login that can write')] });
  const CHAIN = report({ name: '/repo/services/api/src/ask/demo-chain.neo4j.test.ts', tests: [passed('answers every question that expects an intent, with every statement of a summary cited and every cited element in the result; a heavy stop is continued')] });
  const askEval = (total: number | 'none') => (request: ExecRequest): ExecResult => (request.args[0] === 'ask-eval' ? execResult({ output: total === 'none' ? 'no json here\n' : `${JSON.stringify({ plans: { total, right: total, allowedMisses: 2 } })}\n` }) : execResult());

  it('fail with the missing setting named and start nothing when there is no connection', async () => {
    const { fake, files, context } = suites({ readme: '', reports: {} });
    for (const check of [askSafetyReadTransactionCheck(files, NO_FILE), askCitedSummaryCheck(files, NO_FILE)]) {
      const outcome = await check.run({ ...context, env: { NBX_EE_URI: 'bolt://x:7687' } });
      expect(outcome).toMatchObject({ status: 'failed', detail: 'Neo4j connection not set: NBX_EE_USER, NBX_EE_PASSWORD' });
    }
    expect(fake.requests).toEqual([]);
  });

  it('pass when the named test passed, and the cited summary carries the number of demo questions from the evaluation tool’s loader', async () => {
    const { files, context } = connected({ 'ask-safety-read-transaction': TRANSACTION, 'ask-cited-summary': CHAIN }, askEval(28));
    expect(await askSafetyReadTransactionCheck(files, NO_FILE).run(context)).toMatchObject({ status: 'passed' });
    const cited = await askCitedSummaryCheck(files, NO_FILE).run(context);
    expect(cited).toMatchObject({ status: 'passed' });
    expect((cited.data as { figure: string }).figure).toContain('28 demo questions that expect an intent');
  });

  it('fail when the named test did not pass, when the question count cannot be read and when there are no questions', async () => {
    const other = report({ name: '/repo/services/api/src/ask/demo-chain.neo4j.test.ts', tests: [passed('something else')] });
    const wrong = connected({ 'ask-cited-summary': other }, askEval(28));
    expect((await askCitedSummaryCheck(wrong.files, NO_FILE).run(wrong.context)).detail).toContain('the required test did not pass');
    const unreadable = connected({ 'ask-cited-summary': CHAIN }, askEval('none'));
    expect((await askCitedSummaryCheck(unreadable.files, NO_FILE).run(unreadable.context)).detail).toBe('the figure of the check could not be read');
    const zero = connected({ 'ask-cited-summary': CHAIN }, askEval(0));
    expect((await askCitedSummaryCheck(zero.files, NO_FILE).run(zero.context)).detail).toBe('the figure of the check could not be read');
    const failing = connected({ 'ask-safety-read-transaction': TRANSACTION }, () => execResult({ exitCode: 1 }));
    expect((await askSafetyReadTransactionCheck(failing.files, NO_FILE).run(failing.context)).detail).toBe('exited with code 1');
  });
});
