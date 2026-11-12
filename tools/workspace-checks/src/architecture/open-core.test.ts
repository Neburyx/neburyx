import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../workspace.js';
import { checkOpenCore, OPEN_CORE_SCAN_ROOTS } from './open-core.js';
import { loadTree } from './tree.js';

const fixtures = join(repoRoot, 'tools', 'workspace-checks', 'fixtures', 'architecture');
const fixture = (name: string) => checkOpenCore(loadTree(join(fixtures, name), { include: OPEN_CORE_SCAN_ROOTS }));
const snippet = (path: string, text: string) => checkOpenCore([{ path, text }]);

describe('the open-core line', () => {
  it('reports a production file that imports ee/ by its path, with the file, the line and the import', () => {
    expect(fixture('ee-import-by-path')).toMatchObject([{ rule: 'open-core', file: 'services/api/src/routes/ask.ts', line: 1, specifier: '../../../../ee/ask/src/index.js' }]);
  });

  it('reports a production file that imports an ee package by its name', () => {
    expect(fixture('ee-import-by-package')).toMatchObject([{ rule: 'open-core', file: 'services/api/src/routes/ask.ts', specifier: '@neburyx/ee-ask' }]);
  });

  it('reports nothing for ee/ code that imports Community type declarations', () => {
    expect(fixture('ee-uses-community-types')).toEqual([]);
  });

  it('exempts the entry script by name and reports another script of deploy/', () => {
    expect(fixture('ee-entry-script')).toMatchObject([{ rule: 'open-core', file: 'deploy/release/publish.mjs', specifier: '../../ee/ask/dist/index.js' }]);
  });

  it('exempts a test file and still reports the production file next to it', () => {
    expect(fixture('ee-test-next-to-production').map((violation) => violation.file)).toEqual(['services/api/src/a.ts']);
  });

  const SPECIFIERS = ['../../../ee/ask/dist/index.js', '../../../ee', '../../../ee/index', '@neburyx/ee-ask', '@neburyx/ee-audit/dist/index.js'];
  const FORMS: readonly (readonly [string, (specifier: string) => string])[] = [
    ['a static import', (specifier) => `import { x } from '${specifier}';`],
    ['a type-only import', (specifier) => `import type { x } from '${specifier}';`],
    ['a side-effect import', (specifier) => `import '${specifier}';`],
    ['a dynamic import', (specifier) => `const m = await import('${specifier}');`],
    ['a require', (specifier) => `const m = require('${specifier}');`],
    ['an import-equals require', (specifier) => `import x = require('${specifier}');`],
    ['an inline type import', (specifier) => `type T = import('${specifier}').X;`],
    ['an export-star', (specifier) => `export * from '${specifier}';`],
    ['a named re-export', (specifier) => `export { x } from '${specifier}';`],
  ];

  it.each(FORMS.flatMap(([form, write]) => SPECIFIERS.map((specifier) => ({ form, specifier, text: write(specifier) }))))('reports $form of $specifier', ({ text, specifier }) => {
    expect(snippet('services/api/src/a.ts', `\n${text}`)).toMatchObject([{ rule: 'open-core', line: 2, specifier }]);
  });

  it('does not report a folder that merely contains the letters, or a package of another name', () => {
    expect(snippet('services/api/src/a.ts', "import { x } from './tree/free.js';\nimport { y } from 'see';\nimport { z } from '@neburyx/contracts';")).toEqual([]);
  });

  it('does not report a computed specifier, which no check of imports can read', () => {
    expect(snippet('services/api/src/a.ts', 'const name = `${root}/ee/ask`;\nawait import(name);')).toEqual([]);
  });

  it('exempts the testing folder of the API', () => {
    expect(snippet('services/api/src/testing/a.ts', "import { x } from '../../../../ee/ask/dist/index.js';")).toEqual([]);
  });
});
