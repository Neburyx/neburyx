import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { repoRoot } from './workspace.js';

const stepSchema = z.object({
  uses: z.string().optional(),
  run: z.string().optional(),
  with: z.record(z.string(), z.string()).optional(),
});
const workflowSchema = z.object({
  on: z.object({ push: z.unknown(), pull_request: z.unknown() }),
  permissions: z.record(z.string(), z.string()),
  jobs: z.record(z.string(), z.object({ steps: z.array(stepSchema) })),
});

const workflow = workflowSchema.parse(parse(readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')));
const rootScripts = z
  .object({ scripts: z.record(z.string(), z.string()) })
  .parse(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))).scripts;
const pinnedAction = /^[\w-]+\/[\w-]+@v\d+\.\d+\.\d+$/;

describe('CI workflow', () => {
  it('runs on push and pull request', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push']);
  });

  it('asks only for read access to the contents', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it('pins every action to a full release version', () => {
    const uses = Object.values(workflow.jobs).flatMap((job) => job.steps.flatMap((step) => step.uses ?? []));
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.filter((action) => !pinnedAction.test(action))).toEqual([]);
  });

  it.each([
    ['lint', 'lint'],
    ['typecheck', 'typecheck'],
    ['unit', 'test'],
    ['build', 'build'],
    ['contract', 'test:contract'],
    ['integration', 'test:integration'],
  ])('job %s installs frozen and ends with the root script %s', (job, script) => {
    const steps = workflow.jobs[job]?.steps ?? [];
    expect(steps.map((step) => step.uses?.split('@')[0] ?? step.run)).toEqual([
      'actions/checkout',
      'actions/setup-node',
      'corepack enable',
      'pnpm install --frozen-lockfile',
      `pnpm ${script}`,
    ]);
    expect(steps[1]?.with).toEqual({ 'node-version-file': '.nvmrc' });
    expect(Object.keys(rootScripts)).toContain(script);
  });

  it('defines exactly the six jobs', () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual(['build', 'contract', 'integration', 'lint', 'typecheck', 'unit']);
  });
});
