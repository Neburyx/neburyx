import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../workspace.js';
import { ADAPTER_SCAN_ROOTS, checkAdapterAccess } from './adapter.js';
import { loadTree, type SourceFile } from './tree.js';
import { formatViolations, type Violation } from './violations.js';

const fixtures = join(repoRoot, 'tools', 'workspace-checks', 'fixtures', 'architecture');
const API = 'services/api/src';

function fixture(name: string): Violation[] {
  return checkAdapterAccess(loadTree(join(fixtures, name), { include: ADAPTER_SCAN_ROOTS }));
}

function snippet(path: string, text: string): Violation[] {
  const file: SourceFile = { path, text };
  return checkAdapterAccess([file]);
}

describe('a route that reaches the adapter', () => {
  it('is reported with its file and import, and not once it goes through the gate', () => {
    expect(fixture('route-side-door')).toMatchObject([{ file: `${API}/routes/search.ts`, specifier: '../sources/neo4j-adapter.js', line: 1 }]);
    expect(fixture('route-via-gate')).toEqual([]);
  });
});

describe('other code that reaches the adapter', () => {
  it.each([
    ['a module outside the gate', 'module-outside-gate', 'gate-composition'],
    ['a route that imports the execute stage', 'executor-outside-gate', 'gate-uses-executor'],
    ['Enterprise code', 'enterprise-side-door', 'enterprise-via-gate'],
    ['a .mts file', 'mts-side-door', 'mts-in-sources'],
  ])('%s is reported, and its twin is not', (_name, failing, twin) => {
    expect(fixture(failing)).toHaveLength(1);
    expect(fixture(twin)).toEqual([]);
  });
});

describe('the driver', () => {
  it('is reported in a file under gate/ and allowed under sources/', () => {
    expect(fixture('gate-imports-driver')).toMatchObject([{ specifier: 'neo4j-driver', reason: 'only the adapter under sources/ talks to the driver' }]);
    expect(fixture('sources-imports-driver')).toEqual([]);
  });

  it('is reported by subpath too, outside sources/', () => {
    expect(snippet(`${API}/routes/x.ts`, "import { y } from 'neo4j-driver/lib/y.js';")).toHaveLength(1);
    expect(snippet(`${API}/routes/x.ts`, "import { y } from 'neo4j-driver-extra';")).toEqual([]);
  });
});

describe('the write probe', () => {
  it('is allowed in the test-source command, which is the one file outside gate/ and sources/ that may import a module under sources/', () => {
    expect(snippet(`${API}/source-test/command.ts`, "import { runWriteProbe } from '../sources/write-probe.js';")).toEqual([]);
    expect(snippet(`${API}/source-test/command.ts`, "import type { ProbeDriver } from '../sources/write-probe.js';")).toEqual([]);
  });

  it('is the only module under sources/ the command may import', () => {
    expect(snippet(`${API}/source-test/command.ts`, "import { createNeo4jExecutor } from '../sources/executor.js';")).toMatchObject([{ rule: 'adapter-access', reason: 'only the gate reaches the adapter' }]);
    expect(snippet(`${API}/source-test/command.ts`, "import { credentialsOf } from '../sources/credentials.js';")).toHaveLength(1);
  });

  it.each([
    ['another file in source-test/', `${API}/source-test/tester.ts`],
    ['a route', `${API}/routes/sources.ts`],
    ['the start module', `${API}/start.ts`],
    ['Enterprise code', 'ee/policy/a.ts'],
  ])('is reported in %s', (_name, file) => {
    const specifier = file.startsWith('ee/') ? `../../${API}/sources/write-probe.js` : `${'../'.repeat(file.split('/').length - API.split('/').length - 1)}sources/write-probe.js`;
    expect(snippet(file, `import { runWriteProbe } from '${specifier.startsWith('.') ? specifier : `./${specifier}`}';`)).toHaveLength(1);
  });
});

describe('test code', () => {
  it('may import the driver, sources/ and the executor modules', () => {
    const imports = "import d from 'neo4j-driver';\nimport { a } from '../sources/neo4j-adapter.js';\nimport { e } from '../gate/execute.js';";
    expect(snippet(`${API}/routes/x.test.ts`, imports)).toEqual([]);
    expect(snippet(`${API}/routes/x.integration.test.ts`, imports)).toEqual([]);
    expect(snippet(`${API}/testing/x.ts`, imports)).toEqual([]);
  });

  it('is reported when production code imports or re-exports it, and not when a test does', () => {
    expect(fixture('production-imports-testing').map((v) => [v.file, v.reason])).toEqual([
      [`${API}/app.ts`, 'production code reaches test code'],
      [`${API}/reexport.ts`, 'production code reaches test code'],
    ]);
    expect(fixture('test-imports-testing')).toEqual([]);
    expect(snippet(`${API}/app.ts`, "import { t } from './app.test.js';")).toHaveLength(1);
  });
});

interface Restricted {
  readonly name: string;
  readonly outside: { readonly file: string; readonly specifier: string };
  readonly inside: { readonly file: string; readonly specifier: string };
}

const restricted: readonly Restricted[] = [
  { name: 'the driver', outside: { file: `${API}/gate/x.ts`, specifier: 'neo4j-driver' }, inside: { file: `${API}/sources/neo4j-adapter.ts`, specifier: 'neo4j-driver' } },
  { name: 'a sources/ module', outside: { file: `${API}/routes/x.ts`, specifier: '../sources/neo4j-adapter.js' }, inside: { file: `${API}/sources/index.ts`, specifier: './neo4j-adapter.js' } },
  { name: 'the execute stage', outside: { file: `${API}/routes/x.ts`, specifier: '../gate/execute.js' }, inside: { file: `${API}/gate/execute.ts`, specifier: './executor.js' } },
  { name: 'the executor types', outside: { file: `${API}/routes/x.ts`, specifier: '../gate/executor.js' }, inside: { file: `${API}/gate/execute.ts`, specifier: './executor.js' } },
  { name: 'the gate dependencies', outside: { file: `${API}/routes/x.ts`, specifier: '../gate/deps.js' }, inside: { file: `${API}/gate/execute.ts`, specifier: './deps.js' } },
];

const forms: readonly [string, (specifier: string) => string][] = [
  ['a named import', (s) => `import { x } from '${s}';`],
  ['a type-only import', (s) => `import type { x } from '${s}';`],
  ['a default import', (s) => `import x from '${s}';`],
  ['a namespace import', (s) => `import * as x from '${s}';`],
  ['a side-effect import', (s) => `import '${s}';`],
  ['an export from', (s) => `export { x } from '${s}';`],
  ['an export star', (s) => `export * from '${s}';`],
  ['a literal dynamic import', (s) => `const m = await import('${s}');`],
  ['a literal require', (s) => `const m = require('${s}');`],
];

describe.each(restricted)('$name', ({ outside, inside }) => {
  it.each(forms)('as %s is reported outside its zone and not inside it', (_form, write) => {
    expect(snippet(outside.file, write(outside.specifier))).toHaveLength(1);
    expect(snippet(inside.file, write(inside.specifier))).toEqual([]);
  });
});

const inlineTypes: readonly [string, string, string, string, string][] = [
  ['the executor types', `${API}/routes/x.ts`, "type E = import('../gate/executor.js').ReadExecutor;", `${API}/gate/execute.ts`, "type E = import('./executor.js').ReadExecutor;"],
  ['a typeof import', `${API}/routes/x.ts`, "type E = typeof import('../sources/neo4j-adapter.js');", `${API}/sources/index.ts`, "type E = typeof import('./neo4j-adapter.js');"],
  ['the driver', `${API}/gate/x.ts`, "type E = import('neo4j-driver').Driver;", `${API}/sources/neo4j-adapter.ts`, "type E = import('neo4j-driver').Driver;"],
];

describe.each(inlineTypes)('an inline type import of %s', (_name, outsideFile, outsideText, insideFile, insideText) => {
  it('is reported outside its zone and not inside it', () => {
    expect(snippet(outsideFile, outsideText)).toHaveLength(1);
    expect(snippet(insideFile, insideText)).toEqual([]);
  });
});

describe('an inline type exported later through an export clause', () => {
  it('is reported from a gate file that is not restricted, and allowed in a restricted module', () => {
    const text = "type R = import('./executor.js').ReadExecutor;\nexport type { R };";
    expect(snippet(`${API}/gate/types.ts`, text)).toHaveLength(1);
    expect(snippet(`${API}/gate/deps.ts`, text)).toEqual([]);
  });

  it('is not reported when the type is private to a class', () => {
    const text = "export class C {\n  private e: import('./executor.js').ReadExecutor;\n}";
    expect(snippet(`${API}/gate/types.ts`, text)).toEqual([]);
  });
});

describe('an exported inline type', () => {
  it('is reported from a gate file that is not restricted, and allowed in a restricted module', () => {
    expect(snippet(`${API}/gate/types.ts`, "export type R = import('./executor.js').ReadExecutor;")).toHaveLength(1);
    expect(snippet(`${API}/gate/deps.ts`, "export type R = import('./executor.js').ReadExecutor;")).toEqual([]);
    expect(snippet(`${API}/gate/types.ts`, "type R = import('./executor.js').ReadExecutor;")).toEqual([]);
  });
});

const forwards: readonly [string, string][] = [
  ['a dynamic import bound and exported', "const e = await import('./execute.js');\nexport { e };"],
  ['a require bound and exported', "const e = require('./execute.js');\nexport default e;"],
  ['a destructured import exported', "const { executeRead } = await import('./execute.js');\nexport { executeRead };"],
  ['a property forwarded as the default export', "import * as e from './execute.js';\nexport default e.executeRead;"],
  ['a property forwarded in an exported constant', "import * as e from './execute.js';\nexport const run = e.executeRead;"],
  ['a CommonJS export', "const e = require('./execute.js');\nmodule.exports = e;"],
];

describe.each(forwards)('%s', (_name, text) => {
  it('is reported from a gate file that is not restricted, and allowed in a restricted module', () => {
    expect(snippet(`${API}/gate/pass.mts`, text)).toHaveLength(1);
    expect(snippet(`${API}/gate/deps.ts`, text)).toEqual([]);
  });
});

const exportedAsLoaded: readonly [string, string][] = [
  ['an exported require', "export const e = require('./execute.js');"],
  ['an exported dynamic import', "export const e = await import('./execute.js');"],
  ['an exported destructured import', "export const { executeRead } = await import('./execute.js');"],
  ['an exported import-equals', "export import e = require('./execute.js');"],
  ['a default export of a require', "export default require('./execute.js');"],
  ['a CommonJS export of a require', "module.exports = require('./execute.js');"],
];

describe.each(exportedAsLoaded)('%s', (_name, text) => {
  it('is reported from a gate file that is not restricted, and allowed in a restricted module', () => {
    expect(snippet(`${API}/gate/pass.mts`, text)).toHaveLength(1);
    expect(snippet(`${API}/gate/deps.ts`, text)).toEqual([]);
  });
});

describe('a name reused in a nested scope', () => {
  it('does not hide the export of an imported restricted binding', () => {
    const text = "import { executeRead as run } from './execute.js';\nfunction helper() {\n  const run = 1;\n  return run;\n}\nexport { run };";
    expect(snippet(`${API}/gate/pass.ts`, text)).toHaveLength(1);
  });

  it('does not report a local value that shadows a restricted import', () => {
    const text = "import { executeRead as run } from './execute.js';\nexport function helper(run: number) {\n  module.exports = run;\n}";
    expect(snippet(`${API}/gate/pass.ts`, text)).toEqual([]);
  });
});

describe('an inline type used inside an implementation', () => {
  it('is not a re-export, so an ordinary gate module may annotate with an executor type', () => {
    const text = "export function f() {\n  const mode: import('./executor.js').ExecuteCall['accessMode'] = 'READ';\n  return mode;\n}";
    expect(snippet(`${API}/gate/pass.ts`, text)).toEqual([]);
  });
});

describe('a folder next to an executor module', () => {
  it('is not the module: importing it from a route is fine, and a re-export from it is not a restricted-module re-export', () => {
    expect(snippet(`${API}/routes/x.ts`, "import { a } from '../gate/deps/index.js';")).toEqual([]);
    expect(snippet(`${API}/routes/x.ts`, "import { a } from '../gate/deps/index';")).toEqual([]);
    expect(snippet(`${API}/routes/x.ts`, "import { a } from '../gate/deps.js';")).toHaveLength(1);
    expect(snippet(`${API}/gate/deps/index.ts`, "export * from '../execute.js';")).toHaveLength(1);
  });
});

describe('a wrapper function around a restricted function', () => {
  it('is not a re-export, and is left to review', () => {
    expect(snippet(`${API}/gate/pass.ts`, "import { executeRead } from './execute.js';\nexport const run = () => executeRead();")).toEqual([]);
  });
});

describe('a module specifier with a query or a fragment', () => {
  it.each(['?x=1', '#frag'])('%s does not hide an executor import', (suffix) => {
    expect(snippet(`${API}/routes/x.mjs`, `const m = await import('../gate/execute.js${suffix}');`)).toHaveLength(1);
    expect(snippet(`${API}/gate/gate.ts`, `const m = await import('./execute.js${suffix}');`)).toEqual([]);
  });
});

describe('a folder whose name ends in .test', () => {
  it('is not test code, while a file or an extensionless name that ends in .test is', () => {
    expect(snippet(`${API}/app.ts`, "import { a } from './helper.test/index.js';")).toEqual([]);
    expect(snippet(`${API}/app.ts`, "import { a } from './helper.test.js';")).toHaveLength(1);
    expect(snippet(`${API}/app.ts`, "import { a } from './helper.test';")).toHaveLength(1);
  });
});

describe('a sibling file with the name of a restricted directory', () => {
  it.each([
    ['sources.js', 0],
    ['testing.js', 0],
    ['sources/index.js', 1],
    ['sources', 1],
    ['testing/gate.js', 1],
  ])('importing ./%s gives %s reports', (specifier, count) => {
    expect(snippet(`${API}/app.ts`, `import { x } from './${specifier}';`)).toHaveLength(count);
  });
});

describe('a re-export of a restricted export', () => {
  it('is reported from gate/types.ts in all four forms and allowed inside restricted modules', () => {
    const found = fixture('reexport-through-types');
    expect(found.map((v) => v.line)).toEqual([3, 4, 5, 6]);
    expect(new Set(found.map((v) => v.reason))).toEqual(new Set(['a restricted export is re-exported through a module that is not restricted']));
    expect(fixture('reexport-in-restricted')).toEqual([]);
  });
});

describe('the real repository tree', () => {
  it('has no way around the gate', () => {
    const violations = checkAdapterAccess(loadTree(repoRoot, { include: ADAPTER_SCAN_ROOTS }));
    expect(formatViolations(violations)).toBe('');
  });

  it('reads the files it is meant to check', () => {
    const paths = loadTree(repoRoot, { include: ADAPTER_SCAN_ROOTS }).map((file) => file.path);
    expect(paths).toEqual(expect.arrayContaining([`${API}/gate/gate.ts`, `${API}/app.ts`]));
  });
});

describe('the modules that take an executor to build a gate', () => {
  it.each(['gate', 'assemble'])('%s is reported from a route, not from the gate or the adapter folder, and not when re-exported through gate/types.ts', (name) => {
    expect(snippet(`${API}/routes/x.ts`, `import { build } from '../gate/${name}.js';`)).toMatchObject([{ file: `${API}/routes/x.ts`, specifier: `../gate/${name}.js`, line: 1 }]);
    expect(snippet(`${API}/gate/source-gate.ts`, `import { build } from './${name}.js';`)).toEqual([]);
    expect(snippet(`${API}/sources/x.ts`, `import { build } from '../gate/${name}.js';`)).toEqual([]);
    expect(snippet(`${API}/gate/types.ts`, `export { build } from './${name}.js';`)).toHaveLength(1);
  });
});
