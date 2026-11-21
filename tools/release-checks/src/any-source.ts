import { join, resolve } from 'node:path';
import { rowsOf, runNamedRows, type LocatedRow } from './ask-safety.js';
import { rowsNotFound, type SuiteFiles, type SuiteRun } from './suite-run.js';
import type { Check, CheckOutcome } from './types.js';

const NOT_IN_CI = /not in CI$/;
const INVENTORY = 'docs/audit-events.md';

const REQUIRED_TESTS = [
  { file: 'services/api/src/profile/preview-guard.test.ts', title: 'passes the hook and reaches the handler once, under a mapping that holds only' },
  { file: 'tools/ask-safety-suite/src/any-source.test.ts', title: 'answers a question of Ask the same under each setting of the flag' },
  { file: 'tools/ask-safety-suite/src/any-source.test.ts', title: 'answers a turn of the assistant the same under each setting of the flag' },
  { file: 'tools/workspace-checks/src/architecture/audit-routing.test.ts', title: 'writes every audit event on the path the inventory says' },
] as const;

const DATA_RULE_FILES = ['src/provider-input.test.ts', 'src/records.test.ts'] as const;

function previewEvents(inventory: string): number {
  return (inventory.match(/^\| `(ask|ai|assistant)\./gm) ?? []).length;
}

export function anySourceCheck(files: SuiteFiles): Check {
  const command = 'the preview guard, the any-source cases, the provider-input and record rows of the safety suite and the audit routing check, each in its own package';
  return {
    id: 'any-source',
    name: 'The preview runs on any source, under the data rules and the audit',
    command,
    run: async (context): Promise<CheckOutcome> => {
      const fail = (detail: string, output = ''): CheckOutcome => ({ status: 'failed', detail, command, exitCode: null, output });
      let table: readonly LocatedRow[];
      try {
        table = await rowsOf(context, files);
      } catch {
        return fail('the table of named tests of the safety suite could not be read');
      }
      const dataRows = table.filter((row) => (DATA_RULE_FILES as readonly string[]).includes(row.file) && (row.kind === undefined || !NOT_IN_CI.test(row.kind)));
      for (const file of DATA_RULE_FILES) if (!dataRows.some((row) => row.file === file)) return fail(`the table holds no row of ${file}`);
      const explicit: LocatedRow[] = REQUIRED_TESTS.map((test) => ({ file: test.file, title: test.title, absolute: resolve(context.repoRoot, test.file) }));
      const rows = [...explicit, ...dataRows];
      const runs: SuiteRun[] = [];
      const outputs: string[] = [];
      const failed = await runNamedRows(context, files, rows, runs, outputs, true);
      if (failed !== undefined) return { status: 'failed', detail: failed.detail, command, exitCode: failed.exitCode, output: outputs.join('') };
      const missing = rowsNotFound(rows, runs, context.repoRoot);
      if (missing.length > 0) return fail(`${missing.length} required tests were not found among the passed tests, first: ${missing[0]?.file ?? ''} “${missing[0]?.title ?? ''}”`, outputs.join(''));
      const inventory = await files.readText(join(context.repoRoot, INVENTORY)).then(previewEvents).catch(() => 0);
      if (inventory === 0) return fail(`${INVENTORY} lists no event that begins ask., ai. or assistant.`, outputs.join(''));
      const tests = runs.reduce((count, run) => count + run.tests.filter((test) => test.status === 'passed').length, 0);
      const figure = `${tests} tests passed; ${explicit.length} required tests and ${dataRows.length} data-rule rows found; ${inventory} audited events of the preview in the inventory`;
      return { status: 'passed', detail: figure, command, exitCode: 0, output: outputs.join(''), data: { figure, tests, auditedEvents: inventory } };
    },
  };
}
