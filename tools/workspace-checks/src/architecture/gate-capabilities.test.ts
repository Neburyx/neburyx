import { describe, expect, it } from 'vitest';
import { checkGateCapabilities } from './gate-capabilities.js';
import type { SourceFile } from './tree.js';

const API = 'services/api/src';

function snippet(path: string, text: string) {
  const file: SourceFile = { path, text };
  return checkGateCapabilities([file]);
}

const FORMS: readonly (readonly [string, (specifier: string) => string])[] = [
  ['a static import', (specifier) => `import { x } from '${specifier}';`],
  ['a type-only import', (specifier) => `import type { x } from '${specifier}';`],
  ['a dynamic import', (specifier) => `const m = await import('${specifier}');`],
  ['a require', (specifier) => `const m = require('${specifier}');`],
  ['an export-star', (specifier) => `export * from '${specifier}';`],
  ['a named re-export', (specifier) => `export { x } from '${specifier}';`],
];

describe.each([
  ['the system principal', 'gate', 'system-principal', 'system-principal'],
  ['createSourceGate', 'gate', 'source-gate', 'source-gate'],
  ['the write probe', 'sources', 'write-probe', 'write-probe'],
  ['the test-source command', 'source-test', 'command', 'test-source-command'],
] as const)('%s', (_name, folderName, moduleName, rule) => {
  const specifierFrom = (_folder: string) => `../${folderName}/${moduleName}.js`;

  it.each(FORMS)('is reported from a production route for %s, naming the file, the line and the import', (_form, write) => {
    expect(snippet(`${API}/routes/a.ts`, `\n${write(specifierFrom('routes'))}`)).toMatchObject([{ rule, file: `${API}/routes/a.ts`, line: 2, specifier: specifierFrom('routes') }]);
  });

  it('is reported from another service folder', () => {
    expect(snippet('services/other/src/a.ts', `import { x } from '../../api/src/${folderName}/${moduleName}.js';`)).toHaveLength(1);
  });

  it('is not reported from test files and from the testing folder', () => {
    expect(snippet(`${API}/gate/a.test.ts`, `import { x } from '../${folderName}/${moduleName}.js';`)).toEqual([]);
    expect(snippet(`${API}/routes/a.test.tsx`, `import { x } from '../${folderName}/${moduleName}.js';`)).toEqual([]);
    expect(snippet(`${API}/testing/a.ts`, `import { x } from '../${folderName}/${moduleName}.js';`)).toEqual([]);
  });
});

describe.each([
  ['the system principal', 'gate', 'system-principal', 'system-principal'],
  ['createSourceGate', 'gate', 'source-gate', 'source-gate'],
] as const)('%s, re-exported from a module that may import it', (_name, folderName, moduleName, rule) => {
  it('is reported', () => {
    expect(snippet(`${API}/gate/types.ts`, `export { x } from './${moduleName}.js';`)).toMatchObject([{ rule }]);
    expect(snippet(`${API}/gate/types.ts`, `import { x } from './${moduleName}.js';\nexport { x };`)).toMatchObject([{ rule }]);
    void folderName;
  });
});

describe('who may import the system principal', () => {
  it('is any file in gate/, and nothing else', () => {
    expect(snippet(`${API}/gate/gate.ts`, "import { SYSTEM_PRINCIPAL } from './system-principal.js';")).toEqual([]);
    expect(snippet(`${API}/start.ts`, "import { SYSTEM_PRINCIPAL } from './gate/system-principal.js';")).toHaveLength(1);
  });
});

describe('who may import createSourceGate', () => {
  it('is gate/, start.ts and the test-source command, and nothing else', () => {
    expect(snippet(`${API}/start.ts`, "import { createSourceGate } from './gate/source-gate.js';")).toEqual([]);
    expect(snippet(`${API}/source-test/command.ts`, "import { createSourceGate } from '../gate/source-gate.js';")).toEqual([]);
    expect(snippet(`${API}/source-test/tester.ts`, "import { createSourceGate } from '../gate/source-gate.js';")).toMatchObject([{ rule: 'source-gate' }]);
    expect(snippet(`${API}/cli.ts`, "import { createSourceGate } from './gate/source-gate.js';")).toHaveLength(1);
    expect(snippet(`${API}/gate/other.ts`, "import { createSourceGate } from './source-gate.js';")).toEqual([]);
    expect(snippet(`${API}/app.ts`, "import { createSourceGate } from './gate/source-gate.js';")).toHaveLength(1);
  });

  it('is reported when the test-source command re-exports it', () => {
    expect(snippet(`${API}/source-test/command.ts`, "export { createSourceGate } from '../gate/source-gate.js';")).toMatchObject([{ rule: 'source-gate' }]);
  });

  it('is reported when start.ts re-exports it', () => {
    expect(snippet(`${API}/start.ts`, "export { createSourceGate } from './gate/source-gate.js';")).toMatchObject([{ rule: 'source-gate' }]);
  });
});

describe('who may import the write probe', () => {
  it('is the test-source command, and nothing else, not even a file under gate/ or sources/', () => {
    expect(snippet(`${API}/source-test/command.ts`, "import { runWriteProbe } from '../sources/write-probe.js';")).toEqual([]);
    expect(snippet(`${API}/source-test/command.ts`, "import type { ProbeAnswer } from '../sources/write-probe.js';")).toEqual([]);
    expect(snippet(`${API}/source-test/tester.ts`, "import { runWriteProbe } from '../sources/write-probe.js';")).toMatchObject([{ rule: 'write-probe', file: `${API}/source-test/tester.ts`, line: 1 }]);
    expect(snippet(`${API}/gate/gate.ts`, "import { runWriteProbe } from '../sources/write-probe.js';")).toMatchObject([{ rule: 'write-probe' }]);
    expect(snippet(`${API}/sources/executor.ts`, "import { runWriteProbe } from './write-probe.js';")).toMatchObject([{ rule: 'write-probe' }]);
    expect(snippet(`${API}/sources/index.ts`, "export { runWriteProbe } from './write-probe.js';")).toMatchObject([{ rule: 'write-probe' }]);
    expect(snippet(`${API}/start.ts`, "import { runWriteProbe } from './sources/write-probe.js';")).toHaveLength(1);
    expect(snippet(`${API}/routes/sources.ts`, "const m = await import('../sources/write-probe.js');")).toHaveLength(1);
  });

  it('is reported when the command re-exports it, and when the command passes it on', () => {
    expect(snippet(`${API}/source-test/command.ts`, "export { runWriteProbe } from '../sources/write-probe.js';")).toMatchObject([{ rule: 'write-probe', reason: 'the write probe is never re-exported' }]);
    expect(snippet(`${API}/source-test/command.ts`, "import { runWriteProbe } from '../sources/write-probe.js';\nexport { runWriteProbe };")).toMatchObject([{ rule: 'write-probe' }]);
  });
});

describe('who may import the test-source command', () => {
  it('is cli.ts, and nothing else', () => {
    expect(snippet(`${API}/cli.ts`, "import { runTestSourceCommand } from './source-test/command.js';")).toEqual([]);
    expect(snippet(`${API}/start.ts`, "import { runTestSourceCommand } from './source-test/command.js';")).toMatchObject([{ rule: 'test-source-command' }]);
    expect(snippet(`${API}/source-test/tester.ts`, "import { runTestSourceCommand } from './command.js';")).toMatchObject([{ rule: 'test-source-command' }]);
    expect(snippet(`${API}/routes/sources.ts`, "const m = await import('../source-test/command.js');")).toHaveLength(1);
  });

  it('is reported when cli.ts re-exports it', () => {
    expect(snippet(`${API}/cli.ts`, "export { runTestSourceCommand } from './source-test/command.js';")).toMatchObject([{ rule: 'test-source-command' }]);
  });
});

describe('a module name that the pre-filter looks for, written with an escape sequence', () => {
  it.each([
    ['the system principal', "import { x } from '../gate/system-princip\\u0061l.js';"],
    ['createSourceGate', "import { x } from '../gate/source-g\\x61te.js';"],
    ['the write probe', "import { x } from '../sources/write-pr\\u006fbe.js';"],
    ['the test-source command', "import { x } from '../source-test/comm\\u0061nd.js';"],
  ])('is still reported from a route: %s', (_name, line) => {
    expect(snippet(`${API}/routes/x.ts`, line)).toHaveLength(1);
  });
});

describe('a specifier with no name in it, written in a folder that holds a capability module', () => {
  it('is read with the folder it resolves to', () => {
    expect(snippet(`${API}/gate/system-principal/a.ts`, "export { x } from '.';")).toMatchObject([{ rule: 'system-principal' }]);
    expect(snippet(`${API}/routes/x.ts`, "export { x } from '.';")).toEqual([]);
  });
});
