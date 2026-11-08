import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults } from 'vitest/config';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.js';

const folder = dirname(fileURLToPath(import.meta.url));
const EXPECTED = ['cursors.test.ts', 'expand.test.ts', 'names.test.ts', 'routes.test.ts', 'tokens.test.ts'];

/** The glob patterns of the unit job that keep a file out; a fuzz file must match none of them. */
function excludedBy(file: string): string[] {
  const excludes = [...(config.test?.exclude ?? configDefaults.exclude)];
  return excludes.filter((pattern) => {
    const suffix = pattern.replace(/^\*\*\//, '');
    return suffix.startsWith('*.') ? file.endsWith(suffix.slice(1)) : file.includes(suffix.replaceAll('**', ''));
  });
}

describe('the fuzz suite in the unit job', () => {
  const files = readdirSync(folder).filter((name) => name.endsWith('.test.ts') && !name.endsWith('.neo4j.test.ts'));

  it('holds every fuzz file, and each runs in the default vitest configuration (the unit job)', () => {
    expect([...files].sort()).toEqual([...EXPECTED, 'included.test.ts'].sort());
    for (const name of files) expect(excludedBy(name), name).toEqual([]);
  });

  it('has a test in each file, and a fixed seed and run count', () => {
    for (const name of EXPECTED) {
      const text = readFileSync(join(folder, name), 'utf8');
      expect(text.match(/^\s*it\(/gm)?.length ?? 0, name).toBeGreaterThan(0);
    }
    const corpus = readFileSync(join(folder, '..', 'testing', 'fuzz-corpus.ts'), 'utf8');
    expect(corpus).toMatch(/FUZZ_SEED = 5017/);
    expect(corpus).toMatch(/FUZZ_RUNS = 120/);
  });

  it('lets a file that is excluded be seen as excluded', () => {
    expect(excludedBy('x.neo4j.test.ts')).not.toEqual([]);
  });
});
