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
const jobSchema = z.object({
  'runs-on': z.string(),
  env: z.record(z.string(), z.string()).optional(),
  strategy: z.object({ 'fail-fast': z.boolean().optional(), matrix: z.record(z.string(), z.array(z.string())) }).optional(),
  steps: z.array(stepSchema),
});
const workflowSchema = z.object({
  on: z.object({ push: z.unknown(), pull_request: z.unknown() }),
  permissions: z.record(z.string(), z.string()),
  jobs: z.record(z.string(), jobSchema),
});

const workflow = workflowSchema.parse(parse(readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')));
const rootScripts = z
  .object({ scripts: z.record(z.string(), z.string()) })
  .parse(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))).scripts;
const pinnedAction = /^[\w-]+\/[\w-]+@v\d+\.\d+\.\d+$/;
const RUNNER = 'ubuntu-26.04';
const PRINT_DOCKER_VERSIONS = 'docker version\ndocker compose version\n';

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

  it('names the runner image of every job, so a change of the default image is a decision', () => {
    expect(Object.entries(workflow.jobs).filter(([, job]) => job['runs-on'] !== RUNNER).map(([name]) => name)).toEqual([]);
  });

  it.each([
    ['lint', 'lint', []],
    ['typecheck', 'typecheck', []],
    ['unit', 'test', []],
    ['build', 'build', []],
    ['contract', 'test:contract', []],
    ['integration', 'test:integration', [PRINT_DOCKER_VERSIONS]],
  ])('job %s installs frozen and ends with the root script %s', (job, script, first) => {
    const steps = workflow.jobs[job]?.steps ?? [];
    expect(steps.map((step) => step.uses?.split('@')[0] ?? step.run)).toEqual([
      ...first,
      'actions/checkout',
      'actions/setup-node',
      'corepack enable',
      'pnpm install --frozen-lockfile',
      `pnpm ${script}`,
    ]);
    expect(steps.find((step) => step.uses?.startsWith('actions/setup-node'))?.with).toEqual({ 'node-version-file': '.nvmrc' });
    expect(Object.keys(rootScripts)).toContain(script);
  });

  it('defines exactly the nine jobs', () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual(['build', 'compose', 'contract', 'image', 'integration', 'lint', 'neo4j', 'typecheck', 'unit']);
  });

  it('runs the Neo4j tests once for each of Neo4j 5.26 and 2026, with the image reaching the tests', () => {
    const job = workflow.jobs['neo4j'];
    expect(job?.strategy).toEqual({ 'fail-fast': false, matrix: { image: ['neo4j:5.26', 'neo4j:2026'] } });
    expect(job?.env).toEqual({ NEBURYX_NEO4J_IMAGE: '${{ matrix.image }}' });
    expect((job?.steps ?? []).map((step) => step.uses?.split('@')[0] ?? step.run)).toEqual([
      PRINT_DOCKER_VERSIONS,
      'actions/checkout',
      'actions/setup-node',
      'corepack enable',
      'pnpm install --frozen-lockfile',
      'pnpm test:neo4j',
    ]);
    expect(job?.steps[2]?.with).toEqual({ 'node-version-file': '.nvmrc' });
    expect(Object.keys(rootScripts)).toContain('test:neo4j');
  });

  it('runs the Neo4j tests of the adapter and of the demo graph tool in the one root script', () => {
    expect(rootScripts['test:neo4j']).toContain('pnpm --filter @neburyx/api test:neo4j');
    expect(rootScripts['test:neo4j']).toContain('pnpm --filter @neburyx/demo-graph test:neo4j');
  });

  it('installs frozen and ends with the compose test in the compose job', () => {
    const steps = workflow.jobs['compose']?.steps ?? [];
    expect(steps.map((step) => step.uses?.split('@')[0] ?? step.run)).toEqual([
      PRINT_DOCKER_VERSIONS,
      'actions/checkout',
      'actions/setup-node',
      'corepack enable',
      'pnpm install --frozen-lockfile',
      'pnpm test:compose',
    ]);
    expect(Object.keys(rootScripts)).toContain('test:compose');
  });

  it('builds the image for both platforms and checks the result, after running the image test', () => {
    const steps = workflow.jobs['image']?.steps ?? [];
    expect(steps.map((step) => step.uses?.split('@')[0] ?? step.run?.split(' ').slice(0, 2).join(' '))).toEqual([
      'docker version\ndocker',
      'actions/checkout',
      'actions/setup-node',
      'corepack enable',
      'pnpm install',
      'docker/setup-qemu-action',
      'docker/setup-buildx-action',
      'pnpm test:image',
      'docker buildx',
      'node deploy/docker/check-platforms.mjs',
    ]);
    const build = steps.find((step) => step.run?.startsWith('docker buildx build'))?.run ?? '';
    expect(build).toContain('--platform linux/amd64,linux/arm64');
    expect(build).toContain('-f deploy/docker/Dockerfile');
    expect(Object.keys(rootScripts)).toContain('test:image');
  });
});
