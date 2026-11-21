import { join, resolve } from 'node:path';
import { rowsOf, runNamedRows, type LocatedRow } from './ask-safety.js';
import { parseNamedTests } from './named-tests.js';
import { rowsNotFound, runPackage, type SuiteFiles, type SuiteRun } from './suite-run.js';
import type { Check, CheckContext, CheckOutcome } from './types.js';

const SUMMARY_SUITE = 'tools/summary-suite';
const SUMMARY_PACKAGE = '@neburyx/summary-suite';
const NOT_IN_CI = /not in CI$/;

/** The canaries that show the summary suite's checks can fail, named by file and the words of a title: the table has no column that says which kind a canary is. */
const REQUIRED_CANARIES = [
  { kind: 'citation', file: 'src/checks.test.ts', words: 'canary: expectCited fails' },
  { kind: 'numeric', file: 'src/checks-on-views.test.ts', words: 'canary: a number is not supported by' },
  { kind: 'leakage', file: 'src/checks.test.ts', words: 'canary: expectNoText finds a sentinel with' },
  { kind: 'leakage', file: 'src/injection.test.ts', words: 'canary: the log check fails when a log line holds the text' },
] as const;

const REPLY_GUARANTEES = ['a reply cites what it was given, states no number its lines do not hold and holds no verdict word', 'a streamed turn carries no model text'] as const;
const RECORD_ROWS_FILE = 'src/records.test.ts';

function viewsOf(cases: string): { readonly views: number; readonly demo: number } | undefined {
  const views = (cases.match(/^ {2}- id: /gm) ?? []).length;
  const demo = (cases.match(/^ {4}source_case: /gm) ?? []).length;
  return views > 0 && demo > 0 ? { views, demo } : undefined;
}

export function summarySuitesCheck(files: SuiteFiles): Check {
  const command = `pnpm --filter ${SUMMARY_PACKAGE} exec vitest run`;
  return {
    id: 'summary-suites',
    name: 'AI case summary: citation, numeric and leakage suites on the demo views',
    command,
    run: async (context): Promise<CheckOutcome> => {
      const fail = (detail: string, run?: SuiteRun): CheckOutcome => ({ status: 'failed', detail, command: run?.command ?? command, exitCode: run?.exitCode ?? null, output: run?.output ?? '' });
      const folder = join(context.repoRoot, SUMMARY_SUITE);
      const table = await files.readText(join(folder, 'README.md')).then(parseNamedTests).catch(() => undefined);
      if (table === undefined) return fail('the table of named tests of the summary suite could not be read');
      const run = await runPackage(context, files, { label: 'summary-suite', package: SUMMARY_PACKAGE, args: [] });
      if (!run.ok) return fail(run.detail, run);
      const required = REQUIRED_CANARIES.map((canary) => ({ ...canary, file: canary.file, title: canary.words, absolute: resolve(folder, canary.file) }));
      const unlisted = required.filter((canary) => !table.some((row) => row.file === canary.file && row.title.includes(canary.words)));
      if (unlisted.length > 0) return fail(`a canary is not a row of the summary suite's table: ${unlisted[0]?.kind ?? ''}, ${unlisted[0]?.file ?? ''}`, run);
      const missing = rowsNotFound(required, [run], context.repoRoot);
      if (missing.length > 0) return fail(`a ${required.find((canary) => canary.words === missing[0]?.title)?.kind ?? ''} canary did not pass: ${missing[0]?.file ?? ''} “${missing[0]?.title ?? ''}”`, run);
      const views = await files.readText(join(folder, 'cases/cases.yaml')).then(viewsOf).catch(() => undefined);
      if (views === undefined) return fail('the views of the labelled set could not be counted', run);
      const tests = run.tests.filter((test) => test.status === 'passed').length;
      const figure = `${tests} tests passed; canaries of the citation, numeric and leakage checks passed; ${views.demo} of ${views.views} labelled views are demo views`;
      return { status: 'passed', detail: figure, command: run.command, exitCode: 0, output: run.output, data: { figure, tests, views: views.views, demoViews: views.demo } };
    },
  };
}

export function assistantRepliesCheck(files: SuiteFiles): Check {
  const command = `the files of the safety suite's table rows about a reply, a streamed turn and the records, in their own packages`;
  return {
    id: 'assistant-replies',
    name: 'Assistant replies: citation, numeric and leakage rows of the safety suite',
    command,
    run: async (context: CheckContext): Promise<CheckOutcome> => {
      const fail = (detail: string, output = ''): CheckOutcome => ({ status: 'failed', detail, command, exitCode: null, output });
      let all: readonly LocatedRow[];
      try {
        all = await rowsOf(context, files);
      } catch {
        return fail('the table of named tests of the safety suite could not be read');
      }
      const rows = all.filter((row) => (row.kind === undefined || !NOT_IN_CI.test(row.kind)) && ((row.guarantee !== undefined && (REPLY_GUARANTEES as readonly string[]).includes(row.guarantee)) || row.file === RECORD_ROWS_FILE));
      for (const guarantee of REPLY_GUARANTEES) if (!rows.some((row) => row.guarantee === guarantee)) return fail(`the table holds no row for the guarantee: ${guarantee}`);
      if (!rows.some((row) => row.file === RECORD_ROWS_FILE)) return fail('the table holds no row of the record cases');
      const runs: SuiteRun[] = [];
      const outputs: string[] = [];
      const failed = await runNamedRows(context, files, rows, runs, outputs, true);
      if (failed !== undefined) return { status: 'failed', detail: failed.detail, command, exitCode: failed.exitCode, output: outputs.join('') };
      const missing = rowsNotFound(rows, runs, context.repoRoot);
      if (missing.length > 0) return fail(`${missing.length} named tests were not found among the passed tests, first: ${missing[0]?.file ?? ''} “${missing[0]?.title ?? ''}”`, outputs.join(''));
      const perGuarantee = REPLY_GUARANTEES.map((guarantee) => `${rows.filter((row) => row.guarantee === guarantee).length} rows for “${guarantee}”`);
      const records = rows.filter((row) => row.file === RECORD_ROWS_FILE).length;
      const figure = `${runs.reduce((count, run) => count + run.tests.filter((test) => test.status === 'passed').length, 0)} tests passed; ${perGuarantee.join('; ')}; ${records} record rows`;
      return { status: 'passed', detail: figure, command, exitCode: 0, output: outputs.join(''), data: { figure, rows: rows.length } };
    },
  };
}
