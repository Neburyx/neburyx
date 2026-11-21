import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { anySourceCheck } from './any-source.js';
import type { SuiteFiles } from './suite-run.js';
import { execResult, fakeExec, testContext } from './testing.js';
import type { CheckContext } from './types.js';

const OWN = '/repo/tools/ask-safety-suite';
const passed = (title: string, status = 'passed') => ({ title, fullName: title, status });
const report = (...files: { name: string; tests: ReturnType<typeof passed>[] }[]): string => JSON.stringify({ testResults: files.map((file) => ({ name: file.name, assertionResults: file.tests })) });
const row = (file: string, title: string): string => `| What | the Ask route | real application | \`${file}\` | ${title} |`;
const README = (...rows: string[]): string => ['## Named tests', '', '| What it proves | Guarantee | Kind | File | Test |', '|---|---|---|---|---|', ...rows, ''].join('\n');
const TABLE = README(row('src/provider-input.test.ts', 'holds no property value'), row('src/records.test.ts', 'holds nothing after'), row('src/other.test.ts', 'not selected'));
const INVENTORY = '| Event | Result |\n|---|---|\n| `ai.case-summary` | any |\n| `assistant.turn.closed` | any |\n| `ask.question` | any |\n| `export.created` | any |\n';

const REPORTS = {
  'named--neburyx-ask-safety-suite': report(
    { name: `${OWN}/src/any-source.test.ts`, tests: [passed('answers a question of Ask the same under each setting of the flag, answered and not refused'), passed('answers a turn of the assistant the same under each setting of the flag, answered and not refused')] },
    { name: `${OWN}/src/provider-input.test.ts`, tests: [passed('holds no property value in any request of any later question')] },
    { name: `${OWN}/src/records.test.ts`, tests: [passed('holds nothing after an answered question')] },
  ),
  'named--neburyx-api': report({ name: '/repo/services/api/src/profile/preview-guard.test.ts', tests: [passed('passes the hook and reaches the handler once, under a mapping that holds only a source that is not synthetic')] }),
  'named--neburyx-workspace-checks': report({ name: '/repo/tools/workspace-checks/src/architecture/audit-routing.test.ts', tests: [passed('writes every audit event on the path the inventory says, builds sinks and queues only where it may, and calls no sink')] }),
};

function run(texts: Record<string, string>) {
  const fake = fakeExec(() => execResult());
  const files: SuiteFiles = {
    readText: (path) => (path in texts ? Promise.resolve(texts[path] ?? '') : Promise.reject(new Error('no such file'))),
    folders: () => Promise.resolve([]),
    packageOf: (path) => Promise.resolve(path.startsWith(OWN) ? { name: '@neburyx/ask-safety-suite', root: OWN } : path.startsWith('/repo/services/api') ? { name: '@neburyx/api', root: '/repo/services/api' } : { name: '@neburyx/workspace-checks', root: '/repo/tools/workspace-checks' }),
  };
  const context: CheckContext = { ...testContext(fake.exec), workDir: '/work' };
  return anySourceCheck(files).run(context).then((outcome) => ({ outcome, requests: fake.requests }));
}

const GOOD = { [join(OWN, 'README.md')]: TABLE, '/repo/docs/audit-events.md': INVENTORY, ...Object.fromEntries(Object.entries(REPORTS).map(([label, text]) => [`/work/${label}.json`, text])) };

describe('the check that the preview runs on any source, under the data rules and the audit (C6)', () => {
  it('requires the guard test, the two any-source cases, the data-rule rows and the audit routing test, and reads the audited events of the preview from the inventory', async () => {
    const { outcome, requests } = await run(GOOD);
    expect(outcome).toMatchObject({ status: 'passed' });
    expect(outcome.data).toMatchObject({ tests: 6, auditedEvents: 3 });
    expect(requests.flatMap((request) => request.args).join(' ')).not.toContain('other.test.ts');
  });

  it('fails a required test that is missing, one that failed, and a data-rule file with no row in the table', async () => {
    const without = report({ name: '/repo/tools/workspace-checks/src/architecture/audit-routing.test.ts', tests: [passed('something else')] });
    expect((await run({ ...GOOD, '/work/named--neburyx-workspace-checks.json': without })).outcome.detail).toContain('required tests were not found');
    const failing = report({ name: '/repo/services/api/src/profile/preview-guard.test.ts', tests: [passed('passes the hook and reaches the handler once', 'failed')] });
    expect((await run({ ...GOOD, '/work/named--neburyx-api.json': failing })).outcome.detail).toContain('did not pass');
    expect((await run({ ...GOOD, [join(OWN, 'README.md')]: README(row('src/records.test.ts', 'holds nothing after')) })).outcome.detail).toBe('the table holds no row of src/provider-input.test.ts');
  });

  it('fails an inventory with no event of the preview, and one that cannot be read', async () => {
    expect((await run({ ...GOOD, '/repo/docs/audit-events.md': '| `export.created` | any |\n' })).outcome.detail).toContain('lists no event that begins ask., ai. or assistant.');
    const { '/repo/docs/audit-events.md': _gone, ...withoutInventory } = GOOD;
    expect((await run(withoutInventory)).outcome.detail).toContain('lists no event');
  });
});
