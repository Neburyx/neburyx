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
  'timeout-minutes': z.number().optional(),
});
const jobSchema = z.object({
  if: z.string().optional(),
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
/** The browser cache of the ux job is keyed by this version, so a new version of the test runner is a new cache. */
const playwrightVersion = z
  .object({ devDependencies: z.record(z.string(), z.string()) })
  .parse(JSON.parse(readFileSync(join(repoRoot, 'tools', 'ux', 'package.json'), 'utf8'))).devDependencies['@playwright/test'];
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

  it('defines exactly the ten jobs, and none of them runs the Neo4j tests: those run against the developer\'s Neo4j server', () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual(['build', 'compose', 'contract', 'dco', 'image', 'integration', 'lint', 'typecheck', 'unit', 'ux']);
    const runs = Object.values(workflow.jobs).flatMap((job) => job.steps.flatMap((step) => step.run ?? []));
    expect(runs.filter((run) => run.includes('test:neo4j'))).toEqual([]);
  });

  it('checks the sign-off of a pull request in the dco job, with the whole history and never on a push', () => {
    const job = workflow.jobs['dco'];
    expect(job?.if).toBe("github.event_name == 'pull_request'");
    const steps = job?.steps ?? [];
    expect(steps.map((step) => step.uses?.split('@')[0] ?? step.run)).toEqual([
      'actions/checkout',
      'actions/setup-node',
      'corepack enable',
      'pnpm install --frozen-lockfile',
      'pnpm check:dco ${{ github.event.pull_request.base.sha }} ${{ github.event.pull_request.head.sha }}',
    ]);
    expect(steps.find((step) => step.uses?.startsWith('actions/checkout'))?.with).toEqual({ 'fetch-depth': '0' });
    expect(rootScripts['check:dco']).toBe('pnpm --filter @neburyx/dco-check build && node tools/dco-check/dist/main.js');
  });

  it('runs the Neo4j tests of the adapter and of the demo graph tool in the one root script, which builds the package that reaches the dev server', () => {
    expect(rootScripts['test:neo4j']).toContain('pnpm --filter @neburyx/api test:neo4j');
    expect(rootScripts['test:neo4j']).toContain('pnpm --filter @neburyx/demo-graph test:neo4j');
    expect(rootScripts['test:neo4j']).toContain('--filter @neburyx/test-neo4j build');
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

  it('builds the app twice, the spike for the benchmark, caches the browser by its version and ends with the browser tests in the ux job', () => {
    const steps = workflow.jobs['ux']?.steps ?? [];
    expect(steps.map((step) => step.uses?.split('@')[0] ?? step.run)).toEqual([
      'actions/checkout',
      'actions/setup-node',
      'corepack enable',
      'pnpm install --frozen-lockfile',
      'pnpm build',
      'pnpm --filter @neburyx/web build:ux',
      'pnpm --filter @neburyx/renderer-spike build:node',
      'pnpm --filter @neburyx/ux-tests check:profile',
      'actions/cache',
      'pnpm --filter @neburyx/ux-tests exec playwright install chromium',
      'pnpm test:ux',
      'actions/upload-artifact',
    ]);
    expect(steps.find((step) => step.uses?.startsWith('actions/cache'))?.with).toEqual({ path: '~/.cache/ms-playwright', key: `playwright-${playwrightVersion}-\${{ runner.os }}` });
    expect(Object.keys(rootScripts)).toContain('test:ux');
  });

  it('holds the browser tests of the ux job to the limits of the runner, selected by name and not by the CI variable', () => {
    expect(workflow.jobs['ux']?.env).toEqual({ NEBURYX_UX_PROFILE: 'runner' });
  });

  it('installs the browser without the system packages, whose apt download of fonts took ten minutes on a slow mirror, and gives the install a limit of its own', () => {
    const install = (workflow.jobs['ux']?.steps ?? []).find((step) => step.run?.includes('playwright install'));
    expect(install?.run).not.toContain('--with-deps');
    expect(install?.['timeout-minutes']).toBe(10);
  });
});

