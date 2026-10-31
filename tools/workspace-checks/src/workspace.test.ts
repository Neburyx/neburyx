import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  enforcesEngines,
  rangeViolations,
  readPackageJson,
  repoRoot,
  resolvesStrict,
  workspaceGlobs,
  workspacePackageDirs,
} from './workspace.js';

const fixtures = join(repoRoot, 'tools', 'workspace-checks', 'fixtures');

describe('workspace layout', () => {
  it('lists apps, services, packages and tools', () => {
    expect(workspaceGlobs()).toEqual(['apps/*', 'services/*', 'packages/*', 'tools/*']);
  });

  it('includes the workspace checks themselves', () => {
    const names = workspacePackageDirs().map((dir) => readPackageJson(dir).name);
    expect(names).toContain('@neburyx/workspace-checks');
  });

  it('refuses a Node outside the pinned range at install time', () => {
    expect(enforcesEngines()).toBe(true);
  });

  it('pins Node 24 for version managers and for the engine check', () => {
    expect(readFileSync(join(repoRoot, '.nvmrc'), 'utf8').trim()).toBe('24');
    expect(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))).toMatchObject({
      engines: { node: '>=24 <25' },
    });
  });
});

describe('strict TypeScript', () => {
  it.each(workspacePackageDirs().map((dir) => [dir.replace(`${repoRoot}/`, ''), dir]))(
    'resolves strict for %s',
    (_name, dir) => {
      expect(resolvesStrict(dir)).toBe(true);
    },
  );

  it('reports a config that turns strict off', () => {
    expect(resolvesStrict(join(fixtures, 'strict-off'))).toBe(false);
  });
});

describe('dependency versions', () => {
  it.each([repoRoot, ...workspacePackageDirs()].map((dir) => [dir.replace(`${repoRoot}/`, '') || '.', dir]))(
    'uses exact versions in %s',
    (_name, dir) => {
      expect(rangeViolations(readPackageJson(dir))).toEqual([]);
    },
  );

  it('reports every range in a fixture', () => {
    expect(rangeViolations(readPackageJson(join(fixtures, 'ranged')))).toEqual([
      'dependencies: left-pad@^1.3.0',
      'devDependencies: example-tool@latest',
    ]);
  });

  it('allows a workspace link and an exact version', () => {
    expect(
      rangeViolations({ name: 'x', dependencies: { '@neburyx/contracts': 'workspace:*', yaml: '2.9.1' } }),
    ).toEqual([]);
  });
});
