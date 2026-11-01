import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { repoRoot } from '../workspace.js';

const scripts = z.object({ scripts: z.record(z.string(), z.string()) });
const workflow = z.object({ jobs: z.record(z.string(), z.object({ steps: z.array(z.object({ run: z.string().optional() })) })) });

function scriptsOf(...path: string[]): Record<string, string> {
  return scripts.parse(JSON.parse(readFileSync(join(repoRoot, ...path, 'package.json'), 'utf8'))).scripts;
}

describe('the workspace checks in CI', () => {
  it('are run by the unit job, which ends with the root test script', () => {
    const ci = workflow.parse(parse(readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')));
    expect(ci.jobs['unit']?.steps.at(-1)?.run).toBe('pnpm test');
  });

  it('are reached by the root test script, which runs every workspace package', () => {
    expect(scriptsOf()['test']).toContain('pnpm -r test');
  });

  it('are in the package whose test script runs all its tests', () => {
    expect(scriptsOf('tools', 'workspace-checks')['test']).toBe('vitest run');
  });

  it('include the check for domain words in the repository, a test of the package that runs them', () => {
    expect(existsSync(join(repoRoot, 'tools', 'workspace-checks', 'src', 'domain-words', 'repo.test.ts'))).toBe(true);
    expect(readFileSync(join(repoRoot, 'tools', 'workspace-checks', 'vitest.config.ts'), 'utf8')).toContain("exclude: [...configDefaults.exclude, 'fixtures/**']");
  });
});
