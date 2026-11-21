import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(resolve(here, '../README.md'), 'utf8');
const section = readme.slice(readme.indexOf('## Named tests'));

interface Named {
  readonly guarantee: string;
  readonly kind: string;
  readonly file: string;
  readonly title: string;
}

/** What the assistant guarantees, in the words the table uses; each has at least one row. */
const ASSISTANT_GUARANTEES = [
  'a follow-up resolves only to an element the application gave, or asks',
  'a turn stops at each of its limits',
  'a refusal of a verdict, raw query text or another source runs nothing',
  'text that holds an instruction runs nothing',
  'a route reads only through the gate and only what a registered tool names',
  'a cancel stops the model call, the reads and the turn',
  'a reply cites what it was given, states no number its lines do not hold and holds no verdict word',
  'every turn is audited once whatever its ending',
  'a streamed turn carries no model text',
  'AI reads leave manual exploration its share',
] as const;

const KINDS = ['real application', 'route rig', 'single module', 'static check'] as const;
const NOT_RUN_IN_CI = /\.(neo4j|integration)\.test\.ts$/;

/** The rows of the table of named tests: the guarantee, the kind of proof, the file and the words of a test's title. */
function namedTestsOf(text: string): Named[] {
  return text
    .split('\n')
    .map((line) => /^\| .* \| ([^|`]+) \| ([^|`]+) \| `([^`]+)` \| (.+) \|$/.exec(line))
    .flatMap((match) => (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined || match[4] === undefined ? [] : [{ guarantee: match[1], kind: match[2], file: match[3], title: match[4] }]));
}

const DECLARES_A_TEST = /^\s*(for \(.*\) )?(it|test)(\.fails|\.each\(.*\))?\(/;

/** The named tests whose words are not on a line that opens a test of their file. */
function missingTests<T extends Pick<Named, 'file' | 'title'>>(named: readonly T[], read: (file: string) => string): T[] {
  return named.filter(({ file, title }) => !read(file).split('\n').some((line) => DECLARES_A_TEST.test(line) && line.includes(title)));
}

/** The guarantees of the list that no row names. */
function guaranteesWithoutRow(named: readonly Named[]): string[] {
  return ASSISTANT_GUARANTEES.filter((guarantee) => !named.some((row) => row.guarantee === guarantee));
}

/** The rows whose file is not there, named by the row. */
function rowsOfMissingFiles(named: readonly Named[], exists: (file: string) => boolean): string[] {
  return named.filter(({ file }) => !exists(file)).map(({ file, title }) => `${file}: ${title}`);
}

/** The rows with no kind of proof, or with a kind that is not one of the four, or a test that CI does not run and a row that does not say so. */
function rowsWithABadKind(named: readonly Named[]): string[] {
  return named
    .filter(({ kind, file }) => {
      const base = kind.replace(/, not in CI$/, '');
      return !(KINDS as readonly string[]).includes(base) || (NOT_RUN_IN_CI.test(file) !== kind.endsWith(', not in CI'));
    })
    .map(({ file, title }) => `${file}: ${title}`);
}

describe('the named tests of the README', () => {
  const named = namedTestsOf(section);

  it('lists the tests, each in a file that exists, with the words of the title of a test the file declares', () => {
    expect(named.length).toBeGreaterThan(25);
    expect(rowsOfMissingFiles(named, (file) => existsSync(resolve(here, '..', file)))).toEqual([]);
    expect(missingTests(named, (file) => readFileSync(resolve(here, '..', file), 'utf8'))).toEqual([]);
  });

  it('names at least one test for each guarantee of the assistant, each row with one kind of proof', () => {
    expect(guaranteesWithoutRow(named)).toEqual([]);
    expect(rowsWithABadKind(named)).toEqual([]);
  });

  it('reports a guarantee with no row, a row that names a file that is gone, a row with no kind or another kind, and a test in a file CI does not run unless its row says so', () => {
    const row = (guarantee: string, kind: string, file: string): Named => ({ guarantee, kind, file, title: 'words' });
    const first = ASSISTANT_GUARANTEES[0];
    const without = named.filter((entry) => entry.guarantee !== first);
    expect(guaranteesWithoutRow(without)).toEqual([first]);
    expect(rowsOfMissingFiles([row(first, 'route rig', 'src/gone.test.ts'), row(first, 'route rig', 'src/named-tests.test.ts')], (file) => existsSync(resolve(here, '..', file)))).toEqual(['src/gone.test.ts: words']);
    expect(rowsWithABadKind([row(first, '', 'a.test.ts'), row(first, 'a stub', 'a.test.ts'), row(first, 'route rig', 'a.test.ts')])).toEqual(['a.test.ts: words', 'a.test.ts: words']);
    expect(rowsWithABadKind([row(first, 'real application', 'a.neo4j.test.ts'), row(first, 'real application, not in CI', 'a.neo4j.test.ts'), row(first, 'real application, not in CI', 'b.test.ts')])).toEqual(['a.neo4j.test.ts: words', 'b.test.ts: words']);
  });

  it('reports a name that is not in its file, and a name that only a comment or a group holds, and a skipped test', () => {
    const files: Record<string, string> = { 'a.test.ts': "// words in a comment\ndescribe('words in a group', () => {\n  it('has other words', () => {});\n  it.skip('is skipped', () => {});\n});\n" };
    const read = (file: string): string => files[file] ?? '';
    const asked = ['words in a comment', 'words in a group', 'has other words', 'is skipped'].map((title) => ({ file: 'a.test.ts', title }));
    expect(missingTests(asked, read).map((entry) => entry.title)).toEqual(['words in a comment', 'words in a group', 'is skipped']);
  });
});
