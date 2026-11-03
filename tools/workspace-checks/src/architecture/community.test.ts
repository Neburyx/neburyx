import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../workspace.js';
import { checkCommunityImports, COMMUNITY_SCAN_EXCLUDES, COMMUNITY_SCAN_ROOTS } from './community.js';
import { loadTree, type SourceFile } from './tree.js';
import { formatViolations, type Violation } from './violations.js';

const fixtures = join(repoRoot, 'tools', 'workspace-checks', 'fixtures', 'architecture');

function fixture(name: string): Violation[] {
  return checkCommunityImports(loadTree(join(fixtures, name), { include: COMMUNITY_SCAN_ROOTS, exclude: ['ee'] }));
}

function snippet(path: string, text: string): Violation[] {
  const file: SourceFile = { path, text };
  return checkCommunityImports([file]);
}

describe('Community code that imports ee/', () => {
  it('is reported with its file and import, and not once the import is gone', () => {
    expect(fixture('ee-relative-import')).toMatchObject([{ file: 'services/api/src/policy.ts', specifier: '../../../ee/policy/index.js', line: 1 }]);
    expect(fixture('no-ee-import')).toEqual([]);
  });

  it.each(['ee', 'ee/policy', '@neburyx/ee', '@neburyx/ee/policy'])('is reported for the package name %s', (specifier) => {
    expect(snippet('services/api/src/x.ts', `import { a } from '${specifier}';`)).toHaveLength(1);
  });

  it.each(['@neburyx/contracts', 'eslint', 'ee-like', '@neburyx/ee-like'])('is not reported for %s', (specifier) => {
    expect(snippet('services/api/src/x.ts', `import { a } from '${specifier}';`)).toEqual([]);
  });

  it('is reported from a .cts file, and a .cts file without it is not', () => {
    expect(fixture('cts-ee-import')).toHaveLength(1);
    expect(fixture('cts-clean')).toEqual([]);
  });

  it('is reported from tools and apps too', () => {
    expect(snippet('tools/x/src/a.ts', "import { a } from '../../../ee/a.js';")).toHaveLength(1);
    expect(snippet('apps/web/src/a.tsx', "import { a } from '../../../ee/a.js';")).toHaveLength(1);
  });
});

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

describe('an import of ee/', () => {
  it.each(forms)('as %s is reported from Community code and not from inside ee/', (_form, write) => {
    expect(snippet('services/api/src/x.ts', write('../../../ee/a.js'))).toHaveLength(1);
    expect(snippet('ee/api/x.ts', write('../../ee/a.js'))).toEqual([]);
  });
});

describe('a name that only looks like ee/', () => {
  it.each(["import { a } from './ee.js';", "import { a } from '@other/ee';", "import { a } from '@other/ee/policy';"])(
    'is not reported: %s',
    (text) => {
      expect(snippet('services/api/src/x.ts', text)).toEqual([]);
    },
  );

  it.each(["const m = await import('../../../ee/a.js?x=1');", "const m = await import('../../../ee/a.js#frag');", "type T = import('../../../ee/a.js').Y;"])(
    'is still reported when written as %s',
    (text) => {
      expect(snippet('services/api/src/x.ts', text)).toHaveLength(1);
    },
  );
});

describe('a folder name written with an escape sequence', () => {
  it('is still reported as ee/', () => {
    expect(snippet('services/api/src/x.ts', "import { a } from '../../../\\u0065e/a.js';")).toHaveLength(1);
    expect(snippet('services/api/src/x.ts', "const m = await import('../../../e\\x65/a.js');")).toHaveLength(1);
    expect(snippet('services/api/src/x.ts', "import { a } from '../../../\\e\\e/a.js';")).toHaveLength(1);
    expect(snippet('services/api/src/x.ts', "import { a } from '../../../\\145e/a.js';")).toHaveLength(1);
    expect(snippet('services/api/src/x.ts', "import { a } from '../../..\\057ee/a.js';")).toHaveLength(1);
  });
});

describe('code under ee/', () => {
  it('may import Community code', () => {
    expect(fixture('ee-inward')).toEqual([]);
    expect(snippet('ee/policy/index.ts', "import { seams } from '../../services/api/src/seams.js';")).toEqual([]);
  });
});

describe('the real repository tree', () => {
  const files = loadTree(repoRoot, { include: COMMUNITY_SCAN_ROOTS, exclude: COMMUNITY_SCAN_EXCLUDES });

  it('has no Community code that imports ee/', () => {
    expect(formatViolations(checkCommunityImports(files))).toBe('');
  });

  it('reads the Community files it is meant to check', () => {
    const paths = files.map((file) => file.path);
    expect(paths).toEqual(expect.arrayContaining(['services/api/src/app.ts', 'tools/workspace-checks/src/workspace.ts']));
    expect(paths.some((path) => path.startsWith('ee/') || path.includes('/fixtures/'))).toBe(false);
  });
});
