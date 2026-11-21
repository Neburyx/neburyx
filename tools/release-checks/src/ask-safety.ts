import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { diskFiles } from './files.js';
import { neo4jConnection } from './connection.js';
import { parseNamedTests, wordsPattern, type NamedRow } from './named-tests.js';
import { rowsNotFound, runPackage, type SuiteFiles, type SuiteRun } from './suite-run.js';
import { describeCommand } from './command-check.js';
import type { Check, CheckContext, CheckOutcome, ExecRequest } from './types.js';

const SUITE = 'tools/ask-safety-suite';
const SAFETY_PACKAGE = '@neburyx/ask-safety-suite';
const NOT_IN_CI = /not in CI$/;
const ASK_ROUTE = 'the Ask route';

const packageJson = z.object({ name: z.string() });

async function diskPackageOf(path: string): Promise<{ readonly name: string; readonly root: string }> {
  let folder = dirname(path);
  for (;;) {
    try {
      return { name: packageJson.parse(JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'))).name, root: folder };
    } catch {
      const parent = dirname(folder);
      if (parent === folder) throw new Error(`no package holds ${path}`);
      folder = parent;
    }
  }
}

export const diskSuiteFiles: SuiteFiles = { ...diskFiles, packageOf: diskPackageOf };

export interface LocatedRow extends NamedRow {
  readonly absolute: string;
}

export async function rowsOf(context: CheckContext, files: SuiteFiles): Promise<readonly LocatedRow[]> {
  const folder = join(context.repoRoot, SUITE);
  const readme = await files.readText(join(folder, 'README.md'));
  return parseNamedTests(readme).map((row) => ({ ...row, absolute: resolve(folder, row.file) }));
}


/** Runs the files of the rows that are not in the safety suite's own package, each package once with only those files; returns the failure of the first run that failed, or nothing, and keeps each run and its output. */
export async function runNamedRows(context: CheckContext, files: SuiteFiles, rows: readonly LocatedRow[], runs: SuiteRun[], outputs: string[], includeOwn = false): Promise<{ readonly detail: string; readonly exitCode: number | null } | undefined> {
  const byPackage = new Map<string, { root: string; files: Set<string> }>();
  for (const row of rows) {
    const owner = await files.packageOf(row.absolute).catch(() => undefined);
    if (owner === undefined) return { detail: `no package holds ${relative(context.repoRoot, row.absolute)}`, exitCode: null };
    if (owner.name === SAFETY_PACKAGE && !includeOwn) continue;
    const group = byPackage.get(owner.name) ?? { root: owner.root, files: new Set<string>() };
    group.files.add(relative(owner.root, row.absolute));
    byPackage.set(owner.name, group);
  }
  for (const [name, group] of [...byPackage].sort(([left], [right]) => left.localeCompare(right))) {
    const run = await runPackage(context, files, { label: `named-${name.replace(/[^\w]/g, '-')}`, package: name, args: [...group.files].sort() });
    runs.push(run);
    outputs.push(run.output);
    if (!run.ok) return { detail: run.detail, exitCode: run.exitCode };
  }
  return undefined;
}

export function askSafetyCheck(files: SuiteFiles = diskSuiteFiles): Check {
  const command = `pnpm --filter ${SAFETY_PACKAGE} exec vitest run, and the files its table of named tests names in their own packages`;
  return {
    id: 'ask-safety',
    name: 'Ask safety suite and the tests its table names',
    command,
    run: async (context): Promise<CheckOutcome> => {
      const fail = (detail: string, output = ''): CheckOutcome => ({ status: 'failed', detail, command, exitCode: null, output });
      let rows: readonly LocatedRow[];
      try {
        rows = await rowsOf(context, files);
      } catch {
        return fail('the table of named tests of the safety suite could not be read');
      }
      if (rows.length === 0) return fail('the table of named tests holds no row');
      const toRun = rows.filter((row) => row.kind === undefined || !NOT_IN_CI.test(row.kind));
      const own = await runPackage(context, files, { label: 'ask-safety-suite', package: SAFETY_PACKAGE, args: [] });
      const runs: SuiteRun[] = [own];
      const outputs = [own.output];
      if (!own.ok) return { status: 'failed', detail: own.detail, command, exitCode: own.exitCode, output: outputs.join('') };
      const others = await runNamedRows(context, files, toRun, runs, outputs);
      if (others !== undefined) return { status: 'failed', detail: others.detail, command, exitCode: others.exitCode, output: outputs.join('') };
      const missing = rowsNotFound(toRun, runs, context.repoRoot);
      if (missing.length > 0) return fail(`${missing.length} named tests were not found among the passed tests, first: ${missing[0]?.file ?? ''} “${missing[0]?.title ?? ''}”`, outputs.join(''));
      const found = toRun.filter((row) => !missing.includes(row));
      const guarantees = [...new Set(rows.flatMap((row) => (row.guarantee === undefined || row.guarantee === ASK_ROUTE ? [] : [row.guarantee])))];
      const uncovered = guarantees.filter((guarantee) => !found.some((row) => row.guarantee === guarantee));
      if (uncovered.length > 0) return fail(`a guarantee of the assistant has no passed row: ${uncovered[0] ?? ''}`, outputs.join(''));
      const tests = runs.reduce((count, run) => count + run.tests.filter((test) => test.status === 'passed').length, 0);
      const figure = `${tests} tests passed; ${found.length} named tests found; ${guarantees.length} guarantees of the assistant, each with a passed row`;
      return { status: 'passed', detail: figure, command, exitCode: 0, output: outputs.join(''), data: { figure, tests, rows: found.length, guarantees: guarantees.length } };
    },
  };
}

function neo4jTestCheck(options: { readonly id: string; readonly name: string; readonly package: string; readonly config: string; readonly file: string; readonly words: string; readonly files: SuiteFiles; readonly settingsFile?: string; readonly figure: (context: CheckContext) => Promise<string | undefined> }): Check {
  const request: ExecRequest = { command: 'pnpm', args: ['--filter', options.package, 'exec', 'vitest', 'run', '--config', options.config, options.file] };
  const command = describeCommand(request);
  return {
    id: options.id,
    name: options.name,
    command,
    run: async (context): Promise<CheckOutcome> => {
      const connection = neo4jConnection(context.env, options.settingsFile);
      if (!connection.ok) return { status: 'failed', detail: connection.detail, command, exitCode: null, output: `${connection.detail}\n` };
      const run = await runPackage(context, options.files, { label: options.id, package: options.package, args: ['--config', options.config, options.file] });
      if (!run.ok) return { status: 'failed', detail: run.detail, command: run.command, exitCode: run.exitCode, output: run.output };
      const pattern = wordsPattern(options.words);
      if (!run.tests.some((test) => test.status === 'passed' && (pattern.test(test.title) || pattern.test(test.fullName)))) return { status: 'failed', detail: `the required test did not pass: ${options.words}`, command: run.command, exitCode: run.exitCode, output: run.output };
      const figure = await options.figure(context);
      if (figure === undefined) return { status: 'failed', detail: 'the figure of the check could not be read', command: run.command, exitCode: run.exitCode, output: run.output };
      return { status: 'passed', detail: figure, command: run.command, exitCode: 0, output: run.output, data: { figure } };
    },
  };
}

export function askSafetyReadTransactionCheck(files: SuiteFiles = diskSuiteFiles, settingsFile?: string): Check {
  return neo4jTestCheck({
    id: 'ask-safety-read-transaction',
    name: 'Ask safety suite: the read transaction refuses a write (Neo4j)',
    package: SAFETY_PACKAGE,
    config: 'vitest.neo4j.config.ts',
    file: 'src/file-query-transaction.neo4j.test.ts',
    words: 'is refused by the explicit READ transaction on a login that can write',
    files,
    ...(settingsFile === undefined ? {} : { settingsFile }),
    figure: async () => 'a write that passed every text check is refused by the read transaction',
  });
}

const demoQuestionsSchema = z.looseObject({ plans: z.object({ total: z.number() }) });

/** The number of demo questions that expect an intent, from the evaluation tool's own loader of the packs' question files. */
async function demoQuestions(context: CheckContext): Promise<string | undefined> {
  const result = await context.exec({ command: 'pnpm', args: ['ask-eval', '--packs', 'domain-packs', '--replay', 'tools/ask-eval/data/replay.json', '--json'], cwd: context.repoRoot });
  const line = [...result.output.split('\n')].reverse().find((candidate) => candidate.startsWith('{'));
  if (line === undefined) return undefined;
  try {
    const total = demoQuestionsSchema.parse(JSON.parse(line)).plans.total;
    return total > 0 ? `${total} demo questions that expect an intent, each answered with every statement of its summary cited (one test over all of them)` : undefined;
  } catch {
    return undefined;
  }
}

export function askCitedSummaryCheck(files: SuiteFiles = diskSuiteFiles, settingsFile?: string): Check {
  return neo4jTestCheck({
    id: 'ask-cited-summary',
    name: 'Every statement of Ask’s summary cites returned elements (Neo4j)',
    package: '@neburyx/api',
    config: 'vitest.neo4j.config.ts',
    file: 'src/ask/demo-chain.neo4j.test.ts',
    words: 'answers every question that expects an intent, with every statement of a summary cited',
    files,
    ...(settingsFile === undefined ? {} : { settingsFile }),
    figure: demoQuestions,
  });
}

