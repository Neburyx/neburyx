import { describe, expect, it } from 'vitest';
import { readPackageJson, workspacePackageDirs } from './workspace.js';
import { buildSteps, packagesOf, readScripts, resolveWithPnpm } from '../../ci/prebuild-lists.mjs';

const resolve = (selector: string): readonly string[] => (selector === '@neburyx/api^...' ? ['@neburyx/contracts', '@neburyx/ee-ask'] : ['@neburyx/x']);

describe('prebuild lists', () => {
  it('reads the selectors of every build step, and expands the shared prebuild script', () => {
    const scripts = { 'build:deps': 'pnpm --filter "*^..." build', test: 'pnpm build:deps && pnpm -r test', old: 'pnpm --filter @neburyx/a --filter @neburyx/b build && node x.js', build: 'pnpm -r build' };
    expect(buildSteps(scripts)).toEqual([
      { script: 'build:deps', selectors: ['*^...'] },
      { script: 'test', selectors: ['*^...'] },
      { script: 'old', selectors: ['@neburyx/a', '@neburyx/b'] },
    ]);
  });

  it('lists a plain name as itself and resolves a dependency selector against the workspace, once each', () => {
    expect(packagesOf({ script: 's', selectors: ['@neburyx/api^...', '@neburyx/contracts', '@neburyx/ee-ask'] }, resolve)).toEqual(['@neburyx/contracts', '@neburyx/ee-ask']);
  });

  it('lists the packages in the order the resolver gives them, which is the order they build in', () => {
    expect(packagesOf({ script: 's', selectors: ['@neburyx/api^...'] }, () => ['@neburyx/contracts', '@neburyx/ee-audit', '@neburyx/ee-ask'])).toEqual(['@neburyx/contracts', '@neburyx/ee-audit', '@neburyx/ee-ask']);
  });

  it('reads the scripts at a given revision', () => {
    const exec = (tool: string, args: readonly string[]) => ({ status: 0, stdout: JSON.stringify({ scripts: { old: `${tool} ${args.join(' ')}` } }) });
    expect(readScripts('abc123', exec)).toEqual({ old: 'git show abc123:package.json' });
  });

  it('refuses an unknown revision instead of listing nothing', () => {
    expect(() => readScripts('nope', () => ({ status: 128, stdout: '' }))).toThrow('git could not read package.json at nope');
  });

  it('prints the packages of a real selection in the same order on every run, each after its workspace dependencies', () => {
    const first = resolveWithPnpm('@neburyx/api^...');
    expect([...first].sort()).toEqual(['@neburyx/contracts', '@neburyx/ee-ask', '@neburyx/ee-audit', '@neburyx/test-containers', '@neburyx/test-neo4j']);
    expect(resolveWithPnpm('@neburyx/api^...')).toEqual(first);
    const dependenciesOf = (name: string): readonly string[] => {
      const pkg = workspacePackageDirs().map((dir) => readPackageJson(dir)).find((candidate) => candidate.name === name);
      return Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies });
    };
    first.forEach((name, index) => expect(dependenciesOf(name).filter((dependency) => first.includes(dependency)).every((dependency) => first.indexOf(dependency) < index)).toBe(true));
  });
});
