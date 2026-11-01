import { describe, expect, it } from 'vitest';
import { readImports, type ImportForm } from './imports.js';
import { resolveRelative } from './resolve.js';

describe('readImports', () => {
  it.each<[string, string, ImportForm, boolean]>([
    ["import { a } from 'x';", 'x', 'static', false],
    ["import type { a } from 'x';", 'x', 'type', false],
    ["import a from 'x';", 'x', 'static', false],
    ["import * as a from 'x';", 'x', 'static', false],
    ["import 'x';", 'x', 'side-effect', false],
    ["export { a } from 'x';", 'x', 'export-from', true],
    ["export { a as b } from 'x';", 'x', 'export-from', true],
    ["export * from 'x';", 'x', 'export-star', true],
    ["export type { a } from 'x';", 'x', 'export-from', true],
    ["const m = await import('x');", 'x', 'dynamic', false],
    ["const m = require('x');", 'x', 'require', false],
    ["import m = require('x');", 'x', 'require', false],
    ["import { a } from 'x';\nexport { a };", 'x', 'reexport-binding', true],
    ["import { a } from 'x';\nexport { a as b };", 'x', 'reexport-binding', true],
    ["import a from 'x';\nexport default a;", 'x', 'reexport-binding', true],
    ["import * as a from 'x';\nexport { a };", 'x', 'reexport-binding', true],
  ])('reads %j', (source, specifier, form, reexport) => {
    const refs = readImports('file.ts', source);
    expect(refs.at(-1)).toMatchObject({ specifier, form, reexport });
  });

  it.each<[string, string, ImportForm, boolean]>([
    ["type T = import('x').Y;", 'x', 'type', false],
    ["type T = typeof import('x');", 'x', 'type', false],
    ["export type T = import('x').Y;", 'x', 'type', true],
    ["export interface I {\n  a: import('x').Y;\n}", 'x', 'type', true],
    ["const e = await import('x');\nexport { e };", 'x', 'reexport-binding', true],
    ["const e = require('x');\nexport default e;", 'x', 'reexport-binding', true],
    ["import e = require('x');\nexport = e;", 'x', 'reexport-binding', true],
    ["const { f } = await import('x');\nexport { f };", 'x', 'reexport-binding', true],
    ["import * as e from 'x';\nexport default e.f;", 'x', 'reexport-binding', true],
    ["import * as e from 'x';\nexport const f = e.g;", 'x', 'reexport-binding', true],
    ["import * as e from 'x';\nexport const f = e['g'];", 'x', 'reexport-binding', true],
    ["const e = require('x');\nmodule.exports = e;", 'x', 'reexport-binding', true],
    ["const e = require('x');\nexports.f = e.f;", 'x', 'reexport-binding', true],
  ])('reads %j', (source, specifier, form, reexport) => {
    expect(readImports('file.ts', source).at(-1)).toMatchObject({ specifier, form, reexport });
  });

  it.each([
    "import * as e from 'x';\nexport const f = () => e.g();",
    "import * as e from 'x';\nexport function f() {\n  return e.g;\n}",
    "import * as e from 'x';\nconst f = e.g;\nexport { f };",
  ])('does not call %j a forwarded binding', (source) => {
    expect(readImports('file.ts', source).filter((ref) => ref.form === 'reexport-binding')).toEqual([]);
  });

  it('follows an imported binding to the export even when a nested scope reuses its name', () => {
    const source = "import { a as run } from 'x';\nfunction helper() {\n  const run = await import('node:path');\n  return run;\n}\nexport { run };";
    expect(readImports('file.ts', source).filter((ref) => ref.form === 'reexport-binding')).toMatchObject([{ specifier: 'x' }]);
  });

  it.each([
    "type R = import('x').Y;\nexport type { R };",
    "interface I {\n  a: import('x').Y;\n}\nexport { I };",
    "class C {\n  a: import('x').Y;\n}\nexport { C as D };",
  ])('reads a type that holds an inline import and is exported later: %j', (source) => {
    expect(readImports('file.ts', source).filter((ref) => ref.form === 'reexport-binding')).toMatchObject([{ specifier: 'x' }]);
  });

  it.each([
    "type R = import('x').Y;\nexport const v = 1;",
    "type R = import('x').Y;\ntype S = string;\nexport type { S };",
    "class C {\n  private a: import('x').Y;\n}\nexport { C };",
  ])('does not report a hidden or unexported inline import: %j', (source) => {
    expect(readImports('file.ts', source).filter((ref) => ref.form === 'reexport-binding')).toEqual([]);
  });

  it.each([
    "import { a } from 'x';\nconst module = { exports: {} };\nmodule.exports = a;",
    "import { a } from 'x';\nexport function f(exports: Record<string, unknown>) {\n  exports.run = a;\n}",
    "import { a } from 'x';\nfunction g() {\n  const module = { exports: 1 };\n  module.exports = a;\n}",
  ])('does not take a local named module or exports for CommonJS: %j', (source) => {
    expect(readImports('file.ts', source).filter((ref) => ref.form === 'reexport-binding')).toEqual([]);
  });

  it('still reads the CommonJS export of the real module and exports', () => {
    const real = "import { a } from 'x';\nexports.run = a;\nmodule.exports.other = a;";
    expect(readImports('file.cjs', real).filter((ref) => ref.form === 'reexport-binding')).toHaveLength(2);
  });

  it('follows an imported binding past a var in a class static block', () => {
    const source = "import { a as run } from 'x';\nclass C {\n  static {\n    var run = 0;\n  }\n}\nexport { run };";
    expect(readImports('file.ts', source).filter((ref) => ref.form === 'reexport-binding')).toMatchObject([{ specifier: 'x' }]);
  });

  it.each([
    "import { a } from 'x';\nexport const f = function a() {\n  module.exports = a;\n};",
    "import { a } from 'x';\nexport const k = class a {\n  static m = () => module.exports = a;\n};",
    "import { a } from 'x';\n{\n  enum a {\n    A,\n  }\n  exports.f = a;\n}",
    "import { a } from 'x';\n{\n  namespace a {\n    export const z = 1;\n  }\n  exports.f = a;\n}",
    "import { a } from 'x';\nclass C {\n  static {\n    var a = 1;\n    exports.f = a;\n  }\n}",
  ])('does not report a name that shadows the import in a named expression, an enum, a namespace or a static block: %j', (source) => {
    expect(readImports('file.ts', source).filter((ref) => ref.form === 'reexport-binding')).toEqual([]);
  });

  it.each([
    "import { a } from 'x';\nfunction h(a: number) {\n  module.exports = a;\n}",
    "import { a } from 'x';\n{\n  const a = 1;\n  exports.f = a;\n}",
    "import { a } from 'x';\nexport function f() {\n  const a = 1;\n  return a;\n}\nexport const g = (a: number) => a;",
  ])('does not report a name that shadows the import: %j', (source) => {
    expect(readImports('file.ts', source).filter((ref) => ref.form === 'reexport-binding')).toEqual([]);
  });

  it.each<[string, boolean]>([
    ["export type T = import('x').Y;", true],
    ["export function f(a: import('x').Y): void {}", true],
    ["export function f(): import('x').Y {\n  throw new Error();\n}", true],
    ["export class C {\n  a: import('x').Y;\n}", true],
    ["export const v: import('x').Y = w;", true],
    ["export function f() {\n  const mode: import('x').Y['z'] = 'READ';\n  return mode;\n}", false],
    ["export const v = w as import('x').Y;", false],
    ["export class C {\n  m = w as import('x').Y;\n}", false],
    ["export class C {\n  count = new Array<import('x').Y>().length;\n}", false],
    ["export class C {\n  static {\n    const a: import('x').Y = w;\n  }\n}", false],
    ["export function f(a = new Array<import('x').Y>()): void {}", false],
    ["export class C {\n  private a: import('x').Y;\n}", false],
    ["export class C {\n  #a: import('x').Y;\n}", false],
    ["export class C {\n  protected a: import('x').Y;\n}", true],
    ["export class C {\n  private m(): import('x').Y {\n    throw new Error();\n  }\n}", false],
    ["export namespace N {\n  type T = import('x').Y;\n}", false],
    ["export interface I {\n  m(a: import('x').Y): void;\n}", true],
    ["export namespace N {\n  export type T = import('x').Y;\n}", true],
    ["type T = import('x').Y;", false],
  ])('classifies the inline type import in %j as a re-export: %s', (source, reexport) => {
    expect(readImports('file.ts', source).at(-1)).toMatchObject({ form: 'type', reexport });
  });

  it.each<[string, ImportForm, boolean]>([
    ["export const e = require('x');", 'require', true],
    ["export const e = await import('x');", 'dynamic', true],
    ["export const { f } = await import('x');", 'dynamic', true],
    ["export import e = require('x');", 'require', true],
    ["export default require('x');", 'require', true],
    ["module.exports = require('x');", 'require', true],
    ["export const f = () => require('x');", 'require', false],
    ["const e = require('x');", 'require', false],
  ])('classifies %j as exported when loaded: %s', (source, form, reexport) => {
    expect(readImports('file.ts', source).at(-1)).toMatchObject({ form, reexport });
  });

  it.each([
    "const e = require('x');\nmodule . exports = e;",
    "const e = require('x');\n/* a */ module /* b */ . exports /* c */ = e;",
    "const e = require('x');\nmodule\n  .exports.f = e.g;",
  ])('reads a CommonJS export however it is written: %j', (source) => {
    expect(readImports('file.ts', source).filter((ref) => ref.form === 'reexport-binding')).toHaveLength(1);
  });

  it('reports the line of the import', () => {
    expect(readImports('file.ts', "const a = 1;\n\nimport { b } from 'x';")[0]?.line).toBe(3);
  });

  it('ignores an import written inside a string or a comment', () => {
    const source = "const a = \"import { b } from 'x'\";\n// import { c } from 'y';\nconst d = `export * from 'z'`;";
    expect(readImports('file.ts', source)).toEqual([]);
  });

  it('ignores a computed specifier', () => {
    expect(readImports('file.ts', 'const name = "x";\nawait import(name);\nrequire(name);')).toEqual([]);
  });

  it.each(['file.tsx', 'file.mts', 'file.cts', 'file.js', 'file.jsx', 'file.mjs', 'file.cjs'])('reads a file named %s', (name) => {
    expect(readImports(name, "import { a } from 'x';")).toHaveLength(1);
  });
});

describe('resolveRelative', () => {
  it.each([
    ['services/api/src/routes/search.ts', '../sources/neo4j-adapter.js', 'services/api/src/sources/neo4j-adapter'],
    ['services/api/src/gate/gate.ts', './execute.js', 'services/api/src/gate/execute'],
    ['services/api/src/app.ts', './sources/index.js', 'services/api/src/sources'],
    ['services/api/src/routes/search.mts', '../../../../ee/x.mjs', 'ee/x'],
  ])('%s importing %s points at %s', (file, specifier, expected) => {
    expect(resolveRelative(file, specifier)?.path).toBe(expected);
  });

  it('ignores a query or a fragment on the specifier', () => {
    expect(resolveRelative('a/b.ts', './c.js?x=1')?.path).toBe('a/c');
    expect(resolveRelative('a/b.ts', './c.js#frag')?.path).toBe('a/c');
  });

  it('tells an explicit index from a file, with or without an extension', () => {
    expect(resolveRelative('a/b.ts', '../gate/deps/index')).toEqual({ path: 'gate/deps', kind: 'index' });
    expect(resolveRelative('a/b.ts', './helper.test/index.js')).toEqual({ path: 'a/helper.test', kind: 'index' });
  });

  it('tells a file from a directory', () => {
    expect(resolveRelative('a/b.ts', './ee.js')).toEqual({ path: 'a/ee', kind: 'file' });
    expect(resolveRelative('a/b.ts', './ee/index.js')).toEqual({ path: 'a/ee', kind: 'index' });
    expect(resolveRelative('a/b.ts', './ee')).toEqual({ path: 'a/ee', kind: 'bare' });
  });

  it('gives nothing for a package name', () => {
    expect(resolveRelative('a/b.ts', 'neo4j-driver')).toBeUndefined();
  });
});
