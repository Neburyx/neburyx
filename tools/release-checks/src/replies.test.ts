import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assistantRepliesCheck, summarySuitesCheck } from './replies.js';
import type { SuiteFiles } from './suite-run.js';
import { execResult, fakeExec, testContext } from './testing.js';
import type { CheckContext } from './types.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SUMMARY = '/repo/tools/summary-suite';
const OWN = '/repo/tools/ask-safety-suite';
const passed = (title: string, status = 'passed') => ({ title, fullName: title, status });
const report = (...files: { name: string; tests: ReturnType<typeof passed>[] }[]): string => JSON.stringify({ testResults: files.map((file) => ({ name: file.name, assertionResults: file.tests })) });

const SUMMARY_README = [
  '## Named tests', '',
  '| What it proves | File | Test |', '|---|---|---|',
  '| citation | `src/checks.test.ts` | canary: expectCited fails |',
  '| leak | `src/checks.test.ts` | canary: expectNoText finds a sentinel with |',
  '| number | `src/checks-on-views.test.ts` | canary: a number is not supported by |',
  '| log | `src/injection.test.ts` | canary: the log check fails when a log line holds the text |', '',
].join('\n');
const CASES = 'cases:\n  - id: a\n    pack: banking-fraud\n    source_case: x\n  - id: b\n    pack: insurance-claims\n    source_case: y\n  - id: c\n    shape: fan-in\n';
const SUMMARY_REPORT = report(
  { name: `${SUMMARY}/src/checks.test.ts`, tests: [passed('canary: expectCited fails: a sentence with no key'), passed('canary: expectNoText finds a sentinel with a line break')] },
  { name: `${SUMMARY}/src/checks-on-views.test.ts`, tests: [passed('canary: a number is not supported by the digits of an id')] },
  { name: `${SUMMARY}/src/injection.test.ts`, tests: [passed('canary: the log check fails when a log line holds the text')] },
);

function suites(texts: Record<string, string>) {
  const fake = fakeExec(() => execResult());
  const files: SuiteFiles = {
    readText: (path) => (path in texts ? Promise.resolve(texts[path] ?? '') : Promise.reject(new Error('no such file'))),
    folders: () => Promise.resolve([]),
    packageOf: (path) => Promise.resolve(path.startsWith(OWN) ? { name: '@neburyx/ask-safety-suite', root: OWN } : { name: '@neburyx/ee-ask', root: '/repo/ee/ask' }),
  };
  const context: CheckContext = { ...testContext(fake.exec), workDir: '/work' };
  return { fake, files, context };
}

describe('the check of the summary suites on the labelled views (C4, the summary)', () => {
  const GOOD = { [join(SUMMARY, 'README.md')]: SUMMARY_README, [join(SUMMARY, 'cases/cases.yaml')]: CASES, '/work/summary-suite.json': SUMMARY_REPORT };
  const run = (texts: Record<string, string>) => {
    const { files, context } = suites(texts);
    return summarySuitesCheck(files).run(context);
  };

  it('passes when the suite passed whole and a canary of the citation, numeric and leakage checks ran, with the demo views of the set', async () => {
    const outcome = await run(GOOD);
    expect(outcome).toMatchObject({ status: 'passed' });
    expect(outcome.data).toMatchObject({ tests: 4, views: 3, demoViews: 2 });
  });

  it.each([
    ['citation', 'canary: expectCited fails: a sentence with no key'],
    ['numeric', 'canary: a number is not supported by the digits of an id'],
    ['leakage', 'canary: the log check fails when a log line holds the text'],
  ])('fails a missing %s canary, naming its kind', async (kind, title) => {
    const gone = JSON.parse(SUMMARY_REPORT) as { testResults: { assertionResults: { title: string }[] }[] };
    for (const file of gone.testResults) file.assertionResults = file.assertionResults.filter((test) => test.title !== title);
    const outcome = await run({ ...GOOD, '/work/summary-suite.json': JSON.stringify(gone) });
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain(`a ${kind} canary did not pass`);
  });

  it('fails a failed test, a canary that is not a row of the table, and views that cannot be counted', async () => {
    expect((await run({ ...GOOD, '/work/summary-suite.json': report({ name: `${SUMMARY}/src/checks.test.ts`, tests: [passed('x', 'failed')] }) })).detail).toBe('1 tests did not pass in @neburyx/summary-suite');
    expect((await run({ ...GOOD, [join(SUMMARY, 'README.md')]: '## Named tests\n' })).detail).toContain('is not a row of the summary suite');
    expect((await run({ ...GOOD, [join(SUMMARY, 'cases/cases.yaml')]: 'nothing' })).detail).toBe('the views of the labelled set could not be counted');
  });

  it('counts 17 views and 10 demo views in the real set', () => {
    const cases = readFileSync(resolve(repository, 'tools/summary-suite/cases/cases.yaml'), 'utf8');
    expect((cases.match(/^ {2}- id: /gm) ?? []).length).toBe(17);
    expect((cases.match(/^ {4}source_case: /gm) ?? []).length).toBe(10);
  });
});

describe('the check of the assistant’s reply rows (C4, the assistant)', () => {
  const REPLY = 'a reply cites what it was given, states no number its lines do not hold and holds no verdict word';
  const STREAM = 'a streamed turn carries no model text';
  const row = (guarantee: string, kind: string, file: string, title: string): string => `| What | ${guarantee} | ${kind} | \`${file}\` | ${title} |`;
  const README = (...rows: string[]): string => ['## Named tests', '', '| What it proves | Guarantee | Kind | File | Test |', '|---|---|---|---|---|', ...rows, ''].join('\n');
  const ROWS = [row(REPLY, 'single module', '../../ee/ask/src/tool-answer.test.ts', 'drops a number'), row(STREAM, 'real application', 'src/stream.test.ts', 'writes no line'), row('the Ask route', 'real application', 'src/records.test.ts', 'holds nothing'), row('the Ask route', 'real application', 'src/other.test.ts', 'not selected')];
  const REPORTS = {
    'named--neburyx-ee-ask': report({ name: '/repo/ee/ask/src/tool-answer.test.ts', tests: [passed('drops a number that is not in the lines')] }),
    'named--neburyx-ask-safety-suite': report({ name: `${OWN}/src/stream.test.ts`, tests: [passed('writes no line with the text')] }, { name: `${OWN}/src/records.test.ts`, tests: [passed('holds nothing after an answered question')] }),
  };
  const run = (readme: string, reports: Record<string, string> = REPORTS) => {
    const { fake, files, context } = suites({ [join(OWN, 'README.md')]: readme, ...Object.fromEntries(Object.entries(reports).map(([label, text]) => [`/work/${label}.json`, text])) });
    return assistantRepliesCheck(files).run(context).then((outcome) => ({ outcome, requests: fake.requests }));
  };

  it('runs only the files of the rows about a reply, a streamed turn and the records, and passes with its figures', async () => {
    const { outcome, requests } = await run(README(...ROWS));
    expect(outcome).toMatchObject({ status: 'passed' });
    expect(requests.flatMap((request) => request.args).join(' ')).not.toContain('other.test.ts');
    expect((outcome.data as { figure: string }).figure).toContain('3 tests passed');
    expect((outcome.data as { figure: string }).figure).toContain('1 record rows');
  });

  it('fails a missing row of a guarantee, a missing record row, a test that is not found and a failed test', async () => {
    expect((await run(README(ROWS[1] ?? '', ROWS[2] ?? ''))).outcome.detail).toContain(`no row for the guarantee: ${REPLY}`);
    expect((await run(README(ROWS[0] ?? '', ROWS[1] ?? ''))).outcome.detail).toBe('the table holds no row of the record cases');
    expect((await run(README(...ROWS), { ...REPORTS, 'named--neburyx-ee-ask': report({ name: '/repo/ee/ask/src/tool-answer.test.ts', tests: [passed('another')] }) })).outcome.detail).toContain('named tests were not found');
    expect((await run(README(...ROWS), { ...REPORTS, 'named--neburyx-ee-ask': report({ name: '/repo/ee/ask/src/tool-answer.test.ts', tests: [passed('drops a number', 'failed')] }) })).outcome.detail).toContain('did not pass');
  });
});
