import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(resolve(here, '../README.md'), 'utf8');
const section = readme.slice(readme.indexOf('## Named tests'));

interface Named {
  readonly file: string;
  readonly title: string;
}

/** The rows of the table of named tests: the file and the words of a test's title. */
export function namedTestsOf(text: string): Named[] {
  return text
    .split('\n')
    .map((line) => /^\| .* \| `([^`]+)` \| (.+) \|$/.exec(line))
    .flatMap((match) => (match === null || match[1] === undefined || match[2] === undefined ? [] : [{ file: match[1], title: match[2] }]));
}

const DECLARES_A_TEST = /^\s*(for \(.*\) )?(it|test)(\.fails|\.each\(.*\))?\(/;

/** The named tests whose words are not in the title of a test of their file: a line that opens a test and holds the words. */
export function missingTests(named: readonly Named[], read: (file: string) => string): Named[] {
  return named.filter(({ file, title }) => !read(file).split('\n').some((line) => DECLARES_A_TEST.test(line) && line.includes(title)));
}

describe('the named tests of the README', () => {
  const named = namedTestsOf(section);
  const read = (file: string) => readFileSync(resolve(here, '..', file), 'utf8');

  it('lists the tests, each in a file that exists, with the words of the title of a test the file declares', () => {
    expect(named.length).toBeGreaterThan(20);
    expect(missingTests(named, read)).toEqual([]);
  });

  it('reports a name that is not in its file, and a name that only a comment or a group holds, and a skipped test', () => {
    const files: Record<string, string> = { 'a.test.ts': "// words in a comment\ndescribe('words in a group', () => {\n  it('has other words', () => {});\n  it.skip('is skipped', () => {});\n});\n" };
    const rows = [
      { file: 'a.test.ts', title: 'has other words' },
      { file: 'a.test.ts', title: 'words in a comment' },
      { file: 'a.test.ts', title: 'words in a group' },
      { file: 'a.test.ts', title: 'not there at all' },
      { file: 'a.test.ts', title: 'is skipped' },
    ];
    expect(missingTests(rows, (file) => files[file] ?? '').map((row) => row.title)).toEqual(['words in a comment', 'words in a group', 'not there at all', 'is skipped']);
  });
});
