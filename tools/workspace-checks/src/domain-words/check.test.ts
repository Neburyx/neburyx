import { describe, expect, it } from 'vitest';
import { checkDomainWords } from './check.js';
import { makeRoot, packText } from './fixtures.js';
import { PackError } from './packs.js';
import { formatWordViolations } from './violations.js';

const PACK = packText([['widget', 'Widget']], ['MADE_BY']);

function rootWith(source: string): string {
  return makeRoot({ 'domain-packs/sample/neburyx.yaml': PACK, 'services/api/src/a.ts': source });
}

describe('a pack identifier used as a string literal', () => {
  it.each([
    ['an entity type', "export const kind = 'widget';\n", 'widget', 'entity type in sample'],
    ['a label', 'export const kind = "Widget";\n', 'Widget', 'label in sample'],
    ['a relationship type', 'export const edge = `MADE_BY`;\n', 'MADE_BY', 'relationship type in sample'],
  ])('is reported for %s with its file, line, kind and pack, and not once it is removed', (_name, source, word, use) => {
    expect(checkDomainWords(rootWith(`\n${source}`))).toEqual([{ file: 'services/api/src/a.ts', line: 2, word, uses: [use] }]);
    expect(checkDomainWords(rootWith('export const kind = 1;\n'))).toEqual([]);
  });

  it.each(["'widget gadgets'", "'WIDGET'", "'widgets'", "'Widget gadget'", "'made_by'"])('is not reported inside a longer phrase or in a different case: %s', (literal) => {
    expect(checkDomainWords(rootWith(`export const text = ${literal};\n`))).toEqual([]);
  });

  it('formats each violation as file:line with the word and its use', () => {
    const text = formatWordViolations(checkDomainWords(rootWith("export const kind = 'widget';\n")));
    expect(text).toContain("services/api/src/a.ts:1 'widget' is entity type in sample");
    expect(formatWordViolations([])).toBe('');
  });
});

describe('a pack identifier in a web component (.tsx)', () => {
  it('is reported when it is a JSX attribute value or a string in a component, with the file and line', () => {
    const root = makeRoot({ 'domain-packs/sample/neburyx.yaml': PACK, 'apps/web/src/Panel.tsx': "export const Panel = () => <Icon kind=\"widget\" label={'Widget'} />;\n" });
    expect(checkDomainWords(root)).toEqual([
      { file: 'apps/web/src/Panel.tsx', line: 1, word: 'widget', uses: ['entity type in sample'] },
      { file: 'apps/web/src/Panel.tsx', line: 1, word: 'Widget', uses: ['label in sample'] },
    ]);
  });
});

describe('a repository without packs', () => {
  it.each([
    ['no packs folder', { 'services/api/src/a.ts': 'export {};\n' }],
    ['an empty packs folder', { 'domain-packs/README.md': 'none', 'services/api/src/a.ts': 'export {};\n' }],
  ])('fails for %s instead of passing', (_name, files) => {
    expect(() => checkDomainWords(makeRoot(files))).toThrow(PackError);
    expect(() => checkDomainWords(makeRoot(files))).toThrow('no packs found');
  });
});

describe('the three product directories', () => {
  const DIRECTORIES = ['services/api/src/a.ts', 'apps/web/src/a.tsx', 'packages/contracts/src/a.ts'];

  it.each(DIRECTORIES)('are each guarded: a literal in %s fails the check, naming the file and line, and removing it passes', (path) => {
    const base = { 'domain-packs/sample/neburyx.yaml': PACK };
    const broken = makeRoot({ ...base, [path]: "export const ok = 1;\nexport const kind = 'widget';\n" });
    expect(checkDomainWords(broken)).toMatchObject([{ file: path, line: 2, word: 'widget' }]);
    const fixed = makeRoot({ ...base, [path]: 'export const ok = 1;\nexport const kind = 1;\n' });
    expect(checkDomainWords(fixed)).toEqual([]);
  });

  it('are the only places read: other trees and skipped folders are not', () => {
    const text = "export const kind = 'widget';\n";
    const root = makeRoot({
      'domain-packs/sample/neburyx.yaml': PACK,
      'tools/x/src/a.ts': text,
      'ee/x/a.ts': text,
      'services/api/node_modules/p/index.js': text,
      'services/api/dist/a.js': text,
      'apps/web/.git/hook.js': text,
      'packages/contracts/node_modules/q/index.js': text,
      'services/other/a.ts': text,
      'services/api/src/README.md': "'widget'",
    });
    expect(checkDomainWords(root)).toEqual([]);
  });

  it('still reads the others when one is missing', () => {
    const root = makeRoot({ 'domain-packs/sample/neburyx.yaml': PACK, 'apps/web/src/a.tsx': "export const kind = 'widget';\n" });
    expect(checkDomainWords(root)).toMatchObject([{ file: 'apps/web/src/a.tsx' }]);
  });

  it('reports every violation of a run, ordered by file and then by line', () => {
    const root = makeRoot({
      'domain-packs/sample/neburyx.yaml': PACK,
      'services/api/src/b.ts': "export const x = 'MADE_BY';\n",
      'services/api/src/a.ts': "export const x = 'widget';\n\nexport const y = 'Widget';\n",
      'apps/web/src/c.ts': "export const x = 'widget';\n",
    });
    expect(checkDomainWords(root).map((violation) => `${violation.file}:${violation.line}`)).toEqual([
      'apps/web/src/c.ts:1',
      'services/api/src/a.ts:1',
      'services/api/src/a.ts:3',
      'services/api/src/b.ts:1',
    ]);
  });
});
