import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseNamedTests, wordsPattern } from './named-tests.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const readme = (suite: string): string => readFileSync(resolve(repository, 'tools', suite, 'README.md'), 'utf8');

/** The suites' own checks keep their row patterns in a test file nothing can import; these are theirs, word for word. */
const SAFETY_OWN = /^\| .* \| ([^|`]+) \| ([^|`]+) \| `([^`]+)` \| (.+) \|$/;
const SUMMARY_OWN = /^\| .* \| `([^`]+)` \| (.+) \|$/;

describe('the parser of a table of named tests', () => {
  it('reads the five-column form with its guarantee and kind, and the three-column form without them', () => {
    const text = '## Named tests\n\n| What it proves | Guarantee | Kind | File | Test |\n|---|---|---|---|---|\n| A turn stops | a turn stops at each of its limits | real application | `src/a.test.ts` | stops at the steps |\n';
    expect(parseNamedTests(text)).toEqual([{ guarantee: 'a turn stops at each of its limits', kind: 'real application', file: 'src/a.test.ts', title: 'stops at the steps' }]);
    expect(parseNamedTests('## Named tests\n\n| What it proves | File | Test |\n|---|---|---|\n| A citation fails | `src/checks.test.ts` | canary: expectCited fails |\n')).toEqual([{ file: 'src/checks.test.ts', title: 'canary: expectCited fails' }]);
  });

  it('reads the same rows as the safety suite’s own check from its README, each file there', () => {
    const own = readme('ask-safety-suite').slice(readme('ask-safety-suite').indexOf('## Named tests')).split('\n').flatMap((line) => (SAFETY_OWN.exec(line) === null ? [] : [line]));
    const rows = parseNamedTests(readme('ask-safety-suite'));
    expect(rows.length).toBe(own.length);
    expect(rows.length).toBeGreaterThan(80);
    for (const row of rows) expect(existsSync(resolve(repository, 'tools/ask-safety-suite', row.file)), row.file).toBe(true);
    expect(rows.every((row) => row.guarantee !== undefined && row.kind !== undefined)).toBe(true);
  });

  it('reads the same rows as the summary suite’s own check from its README', () => {
    const own = readme('summary-suite').slice(readme('summary-suite').indexOf('## Named tests')).split('\n').flatMap((line) => (SUMMARY_OWN.exec(line) === null ? [] : [line]));
    const rows = parseNamedTests(readme('summary-suite'));
    expect(rows.length).toBe(own.length);
    expect(rows.length).toBeGreaterThan(40);
    expect(rows.some((row) => row.file === 'src/checks.test.ts' && row.title === 'canary: expectCited fails')).toBe(true);
  });
});

describe('the words of a row as a pattern', () => {
  it('finds words from the middle of a title, and an it.each title with %s in the row', () => {
    expect(wordsPattern('own query text for a value that holds').test('sends the folder’s own query text for a value that holds a hostile string')).toBe(true);
    expect(wordsPattern('refuses a start for %s, naming the file').test('refuses a start for a write, naming the file')).toBe(true);
    expect(wordsPattern('bounds the read of %s by the gate').test('bounds the read of a continue by the gate: one page')).toBe(true);
  });

  it('does not find other words, and takes a dot and a bracket as themselves', () => {
    expect(wordsPattern('is refused by the explicit READ transaction').test('is refused by the explicit WRITE transaction')).toBe(false);
    expect(wordsPattern('a.b (c)').test('a-b (c)')).toBe(false);
    expect(wordsPattern('a.b (c)').test('see a.b (c) here')).toBe(true);
  });
});
