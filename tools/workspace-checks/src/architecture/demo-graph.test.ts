import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../workspace.js';
import { checkDemoGraphIsolated, DEMO_GRAPH_SCAN_ROOTS, packagesDependingOnDemoGraph } from './demo-graph.js';
import { loadTree, type SourceFile } from './tree.js';
import { formatViolations } from './violations.js';

function snippet(path: string, text: string) {
  const file: SourceFile = { path, text };
  return checkDemoGraphIsolated([file]);
}

describe('product code that imports the demo graph tool', () => {
  it.each([
    ["import { build } from '@neburyx/demo-graph';", 'services/api/src/a.ts'],
    ["import { build } from '@neburyx/demo-graph/dist/load.js';", 'apps/web/src/a.ts'],
    ["import { build } from '../../../tools/demo-graph/src/load.js';", 'services/api/src/b.ts'],
    ["const tool = await import('../../../tools/demo-graph/src/cli.js');", 'packages/contracts/src/c.ts'],
    ["export * from '../../../tools/demo-graph/src/safety.js';", 'services/api/src/d.ts'],
  ])('is reported: %s', (text, path) => {
    expect(snippet(path, text)).toMatchObject([{ rule: 'demo-graph-isolated', file: path }]);
  });

  it('is reported when an escape sequence spells the folder name', () => {
    expect(snippet('services/api/src/a.ts', "import { build } from '../../../tools/demo-\\u0067raph/src/load.js';")).toHaveLength(1);
    expect(snippet('services/api/src/a.ts', "import { build } from '@neburyx/demo\\-graph';")).toHaveLength(1);
    expect(snippet('services/api/src/a.ts', "import { build } from '@neburyx/demo\\055graph';")).toHaveLength(1);
    expect(snippet('services/api/src/a.ts', "import { build } from '../../..\\057tools/demo-graph/src/load.js';")).toHaveLength(1);
  });

  it.each([
    "import { z } from 'zod';",
    "import { a } from './demo-graph-notes.js';",
    "import { a } from '@neburyx/demo-graph-like';",
    "import { a } from '@neburyx/contracts';",
  ])('is not reported for an unrelated import: %s', (text) => {
    expect(snippet('services/api/src/a.ts', text)).toEqual([]);
  });
});

describe('a package that depends on the demo graph tool', () => {
  const folder = mkdtempSync(join(tmpdir(), 'isolation-'));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  function write(path: string, text: string): void {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  }

  it('is found in any dependency field and in any folder, the root included, and the tool itself is not looked at', () => {
    write('package.json', JSON.stringify({ name: 'root', optionalDependencies: { '@neburyx/demo-graph': 'workspace:*' } }));
    write('services/api/package.json', JSON.stringify({ name: 'a', devDependencies: { '@neburyx/demo-graph': 'workspace:*' } }));
    write('docs/example/package.json', JSON.stringify({ name: 'c', peerDependencies: { '@neburyx/demo-graph/dist': '1.0.0' } }));
    write('services/other/package.json', JSON.stringify({ name: 'b', dependencies: { zod: '1.0.0' } }));
    write('tools/demo-graph/package.json', JSON.stringify({ name: '@neburyx/demo-graph', dependencies: { '@neburyx/demo-graph': '1.0.0' } }));
    write('services/api/node_modules/x/package.json', JSON.stringify({ name: 'x', dependencies: { '@neburyx/demo-graph': '1.0.0' } }));
    expect(packagesDependingOnDemoGraph(folder).sort()).toEqual(['docs/example/package.json', 'package.json', 'services/api/package.json']);
  });
});

describe('the repository', () => {
  it('has no product file that imports the demo graph tool and no package that depends on it', () => {
    const files = loadTree(repoRoot, { include: DEMO_GRAPH_SCAN_ROOTS });
    expect(files.length).toBeGreaterThan(50);
    expect(formatViolations(checkDemoGraphIsolated(files))).toBe('');
    expect(packagesDependingOnDemoGraph(repoRoot)).toEqual([]);
  });
});
