import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BENCHMARK, NARROW, projectsOf, WIDE } from './widths.ts';

const folder = join(import.meta.dirname, '..');
const SHARDS = 3;
const specs = readdirSync(join(folder, 'tests')).filter((name) => name.endsWith('.spec.ts'));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The projects of every test under a suite, however deep its describe blocks go. */
function projectsUnder(suite: unknown): string[] {
  if (!isRecord(suite)) return [];
  const own = listOf(suite['specs']).flatMap((spec) => listOf(isRecord(spec) ? spec['tests'] : undefined).flatMap((test) => (isRecord(test) ? String(test['projectName']) : [])));
  return [...own, ...listOf(suite['suites']).flatMap(projectsUnder)];
}

/** The (spec, project) pairs in the JSON that `playwright test --list --reporter=json` prints, one for each test. */
function pairsIn(output: string): string[] {
  const report: unknown = JSON.parse(output);
  return listOf(isRecord(report) ? report['suites'] : undefined).flatMap((suite) => (isRecord(suite) ? projectsUnder(suite).map((project) => `${String(suite['file'])}:${project}`) : []));
}

/** The (spec, project) pairs Playwright would run for these arguments, listed without running a test. */
function pairsOf(args: readonly string[]): string[] {
  const result = spawnSync('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=json', ...args], { cwd: folder, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  expect(result.status, result.stderr).toBe(0);
  return pairsIn(result.stdout);
}

describe('the shards of the browser tests', () => {
  const laptops = ['--project=laptop-1440', '--project=laptop-1280'];
  const perShard = Array.from({ length: SHARDS }, (_, index) => pairsOf([...laptops, `--shard=${index + 1}/${SHARDS}`]));
  const everything = pairsOf(laptops);

  it('run every test of the two laptop projects in exactly one shard', () => {
    expect(perShard.flat().sort()).toEqual([...everything].sort());
  });

  it('give every shard some work', () => {
    for (const shard of perShard) expect(shard.length).toBeGreaterThan(0);
  });

  it('run every non-benchmark spec in the projects the lists name, and no benchmark', () => {
    const expected = specs.flatMap((file) => projectsOf(file).filter((project) => project !== BENCHMARK).map((project) => `${file}:${project}`));
    const found = new Set(everything.map((pair) => pair.replace(/^tests\//, '')));
    for (const pair of expected) expect(found, pair).toContain(pair);
    expect([...found].filter((pair) => pair.includes('benchmark'))).toEqual([]);
    expect([...found].every((pair) => pair.endsWith(`:${WIDE}`) || pair.endsWith(`:${NARROW}`))).toBe(true);
  });
});
