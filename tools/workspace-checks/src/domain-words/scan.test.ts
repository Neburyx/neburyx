import { describe, expect, it } from 'vitest';
import type { Identifier } from './packs.js';
import { findIdentifierLiterals, indexByName } from './scan.js';

const IDENTIFIERS: Identifier[] = [
  { name: 'widget', kind: 'entity type', pack: 'sample' },
  { name: 'colour', kind: 'property key', pack: 'sample' },
];
const index = indexByName(IDENTIFIERS);

function found(path: string, text: string): string[] {
  return findIdentifierLiterals({ path, text }, index).map((violation) => `${violation.line}:${violation.word}`);
}

describe('the literal forms that are reported', () => {
  it.each([
    ['a string literal', "export const a = 'widget';"],
    ['a double-quoted literal', 'export const a = "widget";'],
    ['a template literal with no substitution', 'export const a = `widget`;'],
    ['a quoted object key', "export const a = { 'widget': 1 };"],
    ['an element access', "export const a = (row: Record<string, number>) => row['widget'];"],
    ['an argument', "export const a = pick('widget');"],
    ['an import specifier', "import 'widget';"],
  ])('%s', (_name, text) => {
    expect(found('services/api/src/a.ts', text)).toEqual(['1:widget']);
  });

  it('a JSX attribute value', () => {
    expect(found('apps/web/src/a.tsx', 'export const a = <input name="widget" />;')).toEqual(['1:widget']);
  });

  it.each(['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'a.test.ts', 'testing/a.ts'])('in the file %s', (name) => {
    const text = name.endsWith('x') ? 'export const a = <i title="widget" />;' : "export const a = 'widget';";
    expect(found(`services/api/src/${name}`, text)).toEqual(['1:widget']);
  });

  it('every literal in a file, each with its own line', () => {
    expect(found('services/api/src/a.ts', "export const a = 'widget';\nexport const b = ['colour',\n  'widget'];")).toEqual(['1:widget', '2:colour', '3:widget']);
  });
});

describe('a JSX attribute written with character references', () => {
  it.each([
    ['a decimal reference', 'export const a = <i title="wi&#100;get" />;'],
    ['a hexadecimal reference', 'export const a = <i title="wi&#x64;get" />;'],
    ['an upper-case hexadecimal marker', 'export const a = <i title="wi&#X64;get" />;'],
  ])('is decoded before matching: %s', (_name, text) => {
    expect(found('apps/web/src/a.tsx', text)).toEqual(['1:widget']);
    expect(found('apps/web/src/a.jsx', text)).toEqual(['1:widget']);
  });

  it('decodes the named references of markup', () => {
    const named = indexByName([{ name: 'R&D', kind: 'label', pack: 'sample' }]);
    expect(findIdentifierLiterals({ path: 'apps/web/src/a.tsx', text: 'export const a = <i title="R&amp;D" />;' }, named)).toHaveLength(1);
  });

  it('leaves a reference it does not know, and a code point out of range, as written', () => {
    expect(found('apps/web/src/a.tsx', 'export const a = <i title="wi&unknown;get" />;')).toEqual([]);
    expect(found('apps/web/src/a.tsx', 'export const a = <i title="wi&#99999999;get" />;')).toEqual([]);
  });

  it('does not touch an ordinary string, where the compiler already reads escapes', () => {
    expect(found('services/api/src/a.ts', "export const a = 'wi&#100;get';")).toEqual([]);
    expect(found('services/api/src/a.ts', "export const a = 'wi\\x64get';")).toEqual(['1:widget']);
  });
});

describe('what is not reported', () => {
  it.each([
    ['a line comment', "// 'widget'\nexport const a = 1;"],
    ['a block comment', "/* 'widget' widget */ export const a = 1;"],
    ['an identifier', 'export const widget = { colour: 1 };'],
    ['a property access', 'export const a = (row: { colour: number }) => row.colour;'],
    ['a template literal with a substitution', 'export const a = (x: string) => `widget${x}` + `${x}colour` + `${x}widget${x}`;'],
    ['a longer phrase', "export const a = 'a widget here';"],
    ['another case', "export const a = 'Widget';"],
    ['an empty literal', "export const a = '';"],
  ])('%s', (_name, text) => {
    expect(found('services/api/src/a.ts', text)).toEqual([]);
  });

  it('JSX text', () => {
    expect(found('apps/web/src/a.tsx', 'export const a = <p>widget</p>;')).toEqual([]);
  });
});

describe('a word that is more than one kind', () => {
  it('is reported once, with every use', () => {
    const both = indexByName([...IDENTIFIERS, { name: 'widget', kind: 'label', pack: 'other' }]);
    const [violation] = findIdentifierLiterals({ path: 'services/api/src/a.ts', text: "export const a = 'widget';" }, both);
    expect(violation?.uses).toEqual(['entity type in sample', 'label in other']);
  });
});
