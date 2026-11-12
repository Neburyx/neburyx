import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  enforcesEngines,
  eeDependencyViolations,
  handKeptBuildFilters,
  unbuiltRunTargets,
  unknownFilterNames,
  unguardedFilterSteps,
  readRootScripts,
  undeclaredWorkspaceImports,
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

  const workspaceRuntimeOf = (name: string): string[] | undefined => {
    const pkg = workspacePackageDirs().map((dir) => readPackageJson(dir)).find((candidate) => candidate.name === name);
    return pkg === undefined ? undefined : Object.entries(pkg.dependencies ?? {}).filter(([, range]) => range.startsWith('workspace:')).map(([found]) => found);
  };

  it('includes the ee/ask package, whose workspace runtime dependencies are the contracts and the audit package', () => {
    expect(workspaceRuntimeOf('@neburyx/ee-ask')).toEqual(['@neburyx/contracts', '@neburyx/ee-audit']);
  });

  it('includes the ee/audit package, whose only workspace runtime dependency is the contracts', () => {
    expect(workspaceRuntimeOf('@neburyx/ee-audit')).toEqual(['@neburyx/contracts']);
  });

  it('has no Community package that depends on an ee package at run time', () => {
    const community = workspacePackageDirs().filter((dir) => !dir.startsWith(join(repoRoot, 'ee')));
    expect(community.length).toBeGreaterThan(5);
    for (const dir of community) expect([dir, eeDependencyViolations(readPackageJson(dir))]).toEqual([dir, []]);
    expect(readPackageJson(join(repoRoot, 'services', 'api')).devDependencies).toHaveProperty('@neburyx/ee-ask');
    expect(readPackageJson(join(repoRoot, 'services', 'api')).devDependencies).toHaveProperty('@neburyx/ee-audit');
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

describe('prebuild reach', () => {
  it('finds a workspace package that is imported but not declared (static, type-only, re-exported, subpath and dynamic imports), so no dependency-aware filter would build it', () => {
    expect(undeclaredWorkspaceImports(join(fixtures, 'prebuild', 'missing-edge'))).toEqual(['@neburyx/demo-graph', '@neburyx/ee-ask', '@neburyx/ee-audit', '@neburyx/test-neo4j']);
  });

  it('accepts a package that declares every workspace package it imports', () => {
    expect(undeclaredWorkspaceImports(join(fixtures, 'prebuild', 'declared-edge'))).toEqual([]);
  });

  it('finds no workspace package that is imported but not declared', () => {
    expect(workspacePackageDirs().flatMap((dir) => undeclaredWorkspaceImports(dir).map((name) => `${readPackageJson(dir).name}: ${name}`))).toEqual([]);
  });

  it('finds a hand-kept package list in a build step', () => {
    expect(handKeptBuildFilters({ test: 'pnpm --filter @neburyx/contracts --filter "@neburyx/api^..." build && pnpm -r test', dev: "pnpm --filter '@neburyx/dev' build:node" })).toEqual(['test: @neburyx/contracts', 'dev: @neburyx/dev']);
  });

  it('leaves the steps that name the package they run, and dependency selectors, alone', () => {
    expect(handKeptBuildFilters({ a: 'pnpm --filter @neburyx/api test:neo4j', b: 'pnpm --filter "*^..." --if-present build:node', c: 'pnpm --filter "@neburyx/api..." build' })).toEqual([]);
  });

  it('has no hand-kept package list in a build step of any root script', () => {
    expect(handKeptBuildFilters(readRootScripts())).toEqual([]);
  });

  it('leaves a step that runs another root script alone, and a dependency selector', () => {
    expect(handKeptBuildFilters({ 'build:deps': 'pnpm --fail-if-no-match --filter "*^..." build', test: 'pnpm build:deps && pnpm -r test' })).toEqual([]);
  });

  it('finds a filter step that would pass when the selector matches no package', () => {
    expect(unguardedFilterSteps({ a: 'pnpm --filter "@neburyx/old^..." build && pnpm --fail-if-no-match --filter @neburyx/api test', b: 'pnpm -r test' })).toEqual(['a: pnpm --filter "@neburyx/old^..." build']);
  });

  it('has a no-match guard on every filter step of every root script', () => {
    expect(unguardedFilterSteps(readRootScripts())).toEqual([]);
  });

  it('finds a package a script runs in whose dependencies no build step of that script builds', () => {
    const scripts = { 'build:deps': 'pnpm --fail-if-no-match --filter "*^..." build', t: 'pnpm --fail-if-no-match --filter "@neburyx/api^..." build && pnpm --fail-if-no-match --filter @neburyx/api test:x && pnpm --fail-if-no-match --filter @neburyx/new-suite test:x' };
    expect(unbuiltRunTargets(scripts)).toEqual(['t: @neburyx/new-suite']);
  });

  it('accepts a run step covered by its own or the shared build step', () => {
    const scripts = { 'build:deps': 'pnpm --fail-if-no-match --filter "*^..." build', a: 'pnpm build:deps && pnpm --fail-if-no-match --filter @neburyx/api test', b: 'pnpm --fail-if-no-match --filter "@neburyx/api..." build && pnpm --fail-if-no-match --filter @neburyx/api run x' };
    expect(unbuiltRunTargets(scripts)).toEqual([]);
  });

  it('has every package a root script runs in covered by a build step of that script', () => {
    expect(unbuiltRunTargets(readRootScripts())).toEqual([]);
  });

  it('finds a filter that names a package the workspace does not have', () => {
    const known = new Set(['@neburyx/api', '@neburyx/contracts']);
    expect(unknownFilterNames({ a: 'pnpm --filter "@neburyx/api^..." --filter "@neburyx/old..." build && pnpm --filter @neburyx/gone test', b: 'pnpm --filter "*^..." build' }, known)).toEqual(['a: @neburyx/old', 'a: @neburyx/gone']);
    expect(unknownFilterNames({ a: 'pnpm --filter "@neburyx/api..." build' }, known)).toEqual([]);
  });

  it('names only workspace packages in every filter of every root script', () => {
    const known = new Set(workspacePackageDirs().map((dir) => readPackageJson(dir).name));
    expect(unknownFilterNames(readRootScripts(), known)).toEqual([]);
  });

  it('builds only the packages something depends on in the shared prebuild, and some package does depend on another', () => {
    expect(readRootScripts()['build:deps']).toBe('pnpm --fail-if-no-match --filter "*^..." build');
    const edges = workspacePackageDirs().flatMap((dir) => Object.values(readPackageJson(dir).dependencies ?? {}).filter((range) => range.startsWith('workspace:')));
    expect(edges.length).toBeGreaterThan(0);
  });

  it.each([
    ['-F @neburyx/a build', 'k: @neburyx/a'],
    ['--filter=@neburyx/a build', 'k: @neburyx/a'],
    ['--filter @neburyx/a build --if-present', 'k: @neburyx/a'],
    ['--if-present --filter "@neburyx/a" build:node', 'k: @neburyx/a'],
    ['--workspace-concurrency 1 --filter @neburyx/a build', 'k: @neburyx/a'],
    ['-C tools/x --filter @neburyx/a build', 'k: @neburyx/a'],
    ['--fail-if-no-match --filter-prod @neburyx/a build', 'k: @neburyx/a'],
    ['--fail-if-no-match --filter-prod=@neburyx/a build', 'k: @neburyx/a'],
  ])('reads a hand-kept build step whatever the flag spelling or position: pnpm %s', (rest, expected) => {
    expect(handKeptBuildFilters({ k: `pnpm ${rest}` })).toEqual([expected]);
  });

  it('judges a run step whatever the flag order, and reports a short-form filter without the guard', () => {
    const scripts = { k: 'pnpm --fail-if-no-match --filter "@neburyx/a^..." build && pnpm --filter @neburyx/x --fail-if-no-match test && pnpm -F @neburyx/y test' };
    expect(unbuiltRunTargets(scripts)).toEqual(['k: @neburyx/x', 'k: @neburyx/y']);
    expect(unguardedFilterSteps(scripts)).toEqual(['k: pnpm -F @neburyx/y test']);
  });

  it('reports a production-only filter step without the guard', () => {
    expect(unguardedFilterSteps({ k: 'pnpm --filter-prod "@neburyx/a..." build' })).toEqual(['k: pnpm --filter-prod "@neburyx/a..." build']);
  });
});
