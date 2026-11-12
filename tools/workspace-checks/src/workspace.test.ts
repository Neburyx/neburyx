import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  enforcesEngines,
  eeDependencyViolations,
  rangeViolations,
  readPackageJson,
  repoRoot,
  resolvesStrict,
  workspaceGlobs,
  workspacePackageDirs,
} from './workspace.js';

const fixtures = join(repoRoot, 'tools', 'workspace-checks', 'fixtures');

describe('workspace layout', () => {
  it('lists apps, ee, services, packages and tools', () => {
    expect(workspaceGlobs()).toEqual(['apps/*', 'ee/*', 'services/*', 'packages/*', 'tools/*']);
  });

  it('includes the workspace checks themselves', () => {
    const names = workspacePackageDirs().map((dir) => readPackageJson(dir).name);
    expect(names).toContain('@neburyx/workspace-checks');
  });

  it('includes the ee/ask package, whose only workspace runtime dependency is the contracts', () => {
    const pkg = workspacePackageDirs().map((dir) => readPackageJson(dir)).find((candidate) => candidate.name === '@neburyx/ee-ask');
    expect(pkg).toBeDefined();
    const runtime = Object.entries(pkg?.dependencies ?? {}).filter(([, range]) => range.startsWith('workspace:')).map(([name]) => name);
    expect(runtime).toEqual(['@neburyx/contracts']);
  });

  it('has no Community package that depends on an ee package at run time', () => {
    const community = workspacePackageDirs().filter((dir) => !dir.startsWith(join(repoRoot, 'ee')));
    expect(community.length).toBeGreaterThan(5);
    for (const dir of community) expect([dir, eeDependencyViolations(readPackageJson(dir))]).toEqual([dir, []]);
    expect(readPackageJson(join(repoRoot, 'services', 'api')).devDependencies).toHaveProperty('@neburyx/ee-ask');
  });

  it.each(['dependencies', 'peerDependencies', 'optionalDependencies'] as const)('reports an ee package in %s and allows it in devDependencies', (field) => {
    expect(eeDependencyViolations({ name: 'x', [field]: { '@neburyx/ee-ask': 'workspace:*' } })).toEqual([`${field}: @neburyx/ee-ask`]);
    expect(eeDependencyViolations({ name: 'x', [field]: { '@neburyx/ee-audit': 'workspace:*' } })).toEqual([`${field}: @neburyx/ee-audit`]);
    expect(eeDependencyViolations({ name: 'x', devDependencies: { '@neburyx/ee-ask': 'workspace:*' } })).toEqual([]);
    expect(eeDependencyViolations({ name: 'x', [field]: { '@neburyx/contracts': 'workspace:*' } })).toEqual([]);
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
