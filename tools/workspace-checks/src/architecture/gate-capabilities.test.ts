import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../workspace.js';
import { checkGateCapabilities, GATE_CAPABILITY_SCAN_ROOTS } from './gate-capabilities.js';
import { loadTree, type SourceFile } from './tree.js';
import { formatViolations } from './violations.js';

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

  it('is reported from Enterprise code and from another service folder', () => {
    expect(snippet('ee/policy/a.ts', `import { x } from '../../${API}/${folderName}/${moduleName}.js';`)).toHaveLength(1);
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
    expect(snippet('ee/policy/a.ts', `import { x } from '../../${API}/sources/write-probe.js';`)).toHaveLength(1);
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

describe('the repository', () => {
  it('imports the system principal and createSourceGate only where it may, and re-exports neither', () => {
    const files = loadTree(repoRoot, { include: GATE_CAPABILITY_SCAN_ROOTS });
    expect(files.length).toBeGreaterThan(50);
    expect(formatViolations(checkGateCapabilities(files))).toBe('');
  });
});

describe('docs/architecture-checks.md', () => {
  it('names the restricted modules of the gate, the system principal, the write probe and the command', () => {
    const text = readFileSync(join(repoRoot, 'docs', 'architecture-checks.md'), 'utf8');
    for (const name of ['gate/gate.ts', 'gate/assemble.ts', 'createSourceGate', 'system-principal', 'sources/write-probe.ts', 'source-test/command.ts', 'cli.ts']) {
      expect(text, `the doc mentions ${name}`).toContain(name);
    }
  });
});
