import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../playwright.config.ts';
import { BENCHMARK, EXEMPT, NARROW, ONLY_1280, projectsOf, WIDE, WIDTH_DEPENDENT, WIDTH_MARKERS } from './widths.ts';

const testsFolder = join(import.meta.dirname, '..', 'tests');
const specs = readdirSync(testsFolder).filter((name) => name.endsWith('.spec.ts'));
const textOf = (file: string): string => readFileSync(join(testsFolder, file), 'utf8');
const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8');

type Pattern = RegExp | string;
const asList = (value: Pattern | readonly Pattern[] | undefined): readonly Pattern[] => (value === undefined ? [] : typeof value === 'string' || value instanceof RegExp ? [value] : value);
const matches = (patterns: readonly Pattern[], file: string): boolean => patterns.some((pattern) => (typeof pattern === 'string' ? file.includes(pattern) : pattern.test(file)));

/** The projects the configuration runs a spec in, from the patterns of the projects. */
function configuredProjectsOf(file: string): string[] {
  return (config.projects ?? [])
    .filter((project) => {
      const included = project.testMatch === undefined || matches(asList(project.testMatch), file);
      return included && !matches(asList(project.testIgnore), file);
    })
    .map((project) => project.name ?? '');
}

describe('the lists of specs that run at more than one width', () => {
  it('name specs that exist, in one list each, and no exemption names a listed spec', () => {
    for (const file of [...WIDTH_DEPENDENT, ...ONLY_1280, ...Object.keys(EXEMPT)]) expect(specs, file).toContain(file);
    const listed = [...WIDTH_DEPENDENT, ...ONLY_1280];
    expect(new Set(listed).size).toBe(listed.length);
    for (const file of Object.keys(EXEMPT)) expect(listed, file).not.toContain(file);
  });

  it('hold every spec that carries a width marker, or exempt it with a reason; an exemption that no marker needs is removed', () => {
    const flagged = specs.filter((file) => WIDTH_MARKERS.some((marker) => marker.test(textOf(file))));
    const covered = new Set([...WIDTH_DEPENDENT, ...ONLY_1280, ...Object.keys(EXEMPT)]);
    expect(flagged.filter((file) => !covered.has(file))).toEqual([]);
    expect(Object.keys(EXEMPT).filter((file) => !flagged.includes(file))).toEqual([]);
    for (const reason of Object.values(EXEMPT)) expect(reason.length).toBeGreaterThan(10);
  });

  it('name the specs that skip unless the window is 1280 wide as the only-1280 specs, and no other', () => {
    const skipping = specs.filter((file) => /viewport\?\.width !== 1280/.test(textOf(file)));
    expect([...skipping].sort()).toEqual([...ONLY_1280].sort());
  });

  it('are named in the README of this tool', () => {
    for (const file of [...WIDTH_DEPENDENT, ...ONLY_1280]) expect(readme, file).toContain(file.replace('.spec.ts', ''));
    expect(readme).toContain('WIDTH_DEPENDENT');
    expect(readme).toContain('ONLY_1280');
  });
});

describe('the projects of the configuration', () => {
  it('run each spec where the lists say: the wide window for every spec but the benchmarks and the narrow-only specs, the narrow one for the two lists, the benchmarks alone', () => {
    for (const file of specs) expect(configuredProjectsOf(file), file).toEqual(projectsOf(file));
  });

  it('run exactly the listed specs at the narrow width and every other non-benchmark spec at the wide one', () => {
    const narrow = specs.filter((file) => configuredProjectsOf(file).includes(NARROW));
    expect([...narrow].sort()).toEqual([...WIDTH_DEPENDENT, ...ONLY_1280].sort());
    const wide = specs.filter((file) => configuredProjectsOf(file).includes(WIDE));
    expect(wide.sort()).toEqual(specs.filter((file) => !file.includes('benchmark') && !ONLY_1280.includes(file)).sort());
    expect(specs.filter((file) => configuredProjectsOf(file).includes(BENCHMARK))).toEqual(specs.filter((file) => file.includes('benchmark')));
  });

  it('keeps the benchmark project after both laptop projects', () => {
    expect(config.projects?.find((project) => project.name === BENCHMARK)?.dependencies).toEqual([WIDE, NARROW]);
  });
});
