import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { repoRoot } from './workspace.js';

const stepSchema = z.object({
  id: z.string().optional(),
  if: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  with: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  env: z.record(z.string(), z.string()).optional(),
  'timeout-minutes': z.number().optional(),
});
const jobSchema = z.object({
  if: z.string().optional(),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  outputs: z.record(z.string(), z.string()).optional(),
  'runs-on': z.string(),
  env: z.record(z.string(), z.string()).optional(),
  strategy: z.object({ 'fail-fast': z.boolean().optional(), matrix: z.record(z.string(), z.array(z.string())) }).optional(),
  steps: z.array(stepSchema),
});
const workflowSchema = z.object({
  on: z.object({ push: z.object({ branches: z.array(z.string()).optional(), tags: z.unknown().optional(), 'tags-ignore': z.unknown().optional() }).passthrough(), pull_request: z.unknown() }),
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

  it('runs a push only for branches, so a pushed tag starts no run', () => {
    expect(workflow.on.push.branches).toEqual(['**']);
    expect(workflow.on.push.tags).toBeUndefined();
    expect(workflow.on.push['tags-ignore']).toBeUndefined();
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

  it('defines exactly these jobs, and none of them runs the Neo4j tests: those run against the developer\'s Neo4j server', () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual(['build', 'changes', 'compose', 'compose-images', 'contract', 'dco', 'image', 'integration', 'lint', 'quickstart', 'typecheck', 'unit', 'ux', 'ux-benchmark']);
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

  it('works out from the changed files whether the image and the quickstart steps are needed, for a push and for a pull request', () => {
    const job = workflow.jobs['changes'];
    expect(job?.steps.map((step) => step.uses?.split('@')[0] ?? step.run)).toEqual(['actions/checkout', 'actions/setup-node', 'node tools/ci/changed-paths.mjs --base "$BASE" --head "$HEAD" >> "$GITHUB_OUTPUT"']);
    expect(job?.steps[0]?.with).toEqual({ 'fetch-depth': '0' });
    expect(job?.steps[2]?.id).toBe('paths');
    expect(job?.steps[2]?.env).toEqual({ BASE: '${{ github.event.pull_request.base.sha || github.event.before }}', HEAD: '${{ github.event.pull_request.head.sha || github.sha }}' });
    expect(job?.outputs).toEqual({ image: '${{ steps.paths.outputs.image }}', quickstart: '${{ steps.paths.outputs.quickstart }}' });
  });

  it('builds the compose images once, saves them as one archive and uploads it', () => {
    const steps = workflow.jobs['compose-images']?.steps ?? [];
    expect(steps.map((step) => step.uses?.split('@')[0] ?? step.run?.split(' ').slice(0, 2).join(' '))).toEqual(['docker version\ndocker', 'actions/checkout', 'docker build', 'docker build', 'docker save', 'actions/upload-artifact']);
    expect(steps[2]?.run).toContain('-f deploy/docker/Dockerfile');
    expect(steps[3]?.run).toContain('-f deploy/demo/loader.Dockerfile');
    expect(steps[4]?.run).toContain('neburyx-ci-test:${{ github.sha }} neburyx-ci-test-loader:${{ github.sha }}');
    expect(steps[5]?.with).toEqual({ name: 'compose-images', path: '${{ runner.temp }}/compose-images.tar', 'retention-days': 1 });
  });

  const composeFiles = (): string[] => readdirSync(join(repoRoot, 'services', 'api', 'src', 'compose')).filter((name) => name.endsWith('.compose.test.ts')).map((name) => `src/compose/${name}`);

  it('runs the compose files as parallel jobs on the shared images, one failure not stopping the others', () => {
    const job = workflow.jobs['compose'];
    expect(job?.needs).toBe('compose-images');
    expect(job?.strategy?.['fail-fast']).toBe(false);
    expect(job?.env).toEqual({ NEBURYX_TEST_IMAGE: 'neburyx-ci-test:${{ github.sha }}', NEBURYX_TEST_LOADER_IMAGE: 'neburyx-ci-test-loader:${{ github.sha }}' });
    const steps = job?.steps ?? [];
    expect(steps.map((step) => step.uses?.split('@')[0] ?? step.run)).toEqual([
      PRINT_DOCKER_VERSIONS,
      'actions/checkout',
      'actions/setup-node',
      'corepack enable',
      'pnpm install --frozen-lockfile',
      'actions/download-artifact',
      'docker load --input ${{ runner.temp }}/compose-images.tar',
      'pnpm test:compose ${{ matrix.files }}',
    ]);
    expect(steps[5]?.with).toEqual({ name: 'compose-images', path: '${{ runner.temp }}' });
    expect(Object.keys(rootScripts)).toContain('test:compose');
  });

  it('runs every compose test file in some job: the matrix, or the quickstart job that runs when the files it reads change', () => {
    const matrixFiles = (workflow.jobs['compose']?.strategy?.matrix['files'] ?? []).flatMap((entry) => entry.split(' '));
    const quickstart = (workflow.jobs['quickstart']?.steps ?? []).flatMap((step) => step.run?.match(/src\/compose\/\S+\.compose\.test\.ts/g) ?? []);
    expect([...matrixFiles, ...quickstart].sort()).toEqual(composeFiles().sort());
    expect(new Set([...matrixFiles, ...quickstart]).size).toBe(matrixFiles.length + quickstart.length);
  });

  it('runs the quickstart test only when the files it reads changed, in its own job that needs no shared image', () => {
    const job = workflow.jobs['quickstart'];
    expect(job?.needs).toBe('changes');
    expect(job?.if).toBe("needs.changes.outputs.quickstart == 'true'");
    expect(job?.steps.map((step) => step.uses?.split('@')[0] ?? step.run)).toEqual([PRINT_DOCKER_VERSIONS, 'actions/checkout', 'actions/setup-node', 'corepack enable', 'pnpm install --frozen-lockfile', 'pnpm test:compose src/compose/readme-quickstart.compose.test.ts']);
    expect(job?.env).toBeUndefined();
  });

  it('builds the image for both platforms and checks the result only when an image file changed, after running the image test on every push', () => {
    const job = workflow.jobs['image'];
    expect(job?.needs).toBe('changes');
    const steps = job?.steps ?? [];
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
    const condition = "needs.changes.outputs.image == 'true'";
    expect(steps.filter((step) => step.if !== undefined).map((step) => [step.uses?.split('@')[0] ?? step.run?.split(' ').slice(0, 2).join(' '), step.if])).toEqual([
      ['docker/setup-qemu-action', condition],
      ['docker buildx', condition],
      ['node deploy/docker/check-platforms.mjs', condition],
    ]);
    const build = steps.find((step) => step.run?.startsWith('docker buildx build'))?.run ?? '';
    expect(build).toContain('--platform linux/amd64,linux/arm64');
    expect(build).toContain('-f deploy/docker/Dockerfile');
    expect(Object.keys(rootScripts)).toContain('test:image');
  });

  const UX_BUILD_STEPS = [
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
  ];

  it('builds the app twice, the spike for the benchmark, caches the browser by its version and runs one shard of the browser tests in each ux job', () => {
    const job = workflow.jobs['ux'];
    expect(job?.strategy).toEqual({ 'fail-fast': false, matrix: { shard: ['1', '2', '3'] } });
    const steps = job?.steps ?? [];
    expect(steps.map((step) => step.uses?.split('@')[0] ?? step.run)).toEqual([...UX_BUILD_STEPS, 'pnpm test:ux --project=laptop-1440 --project=laptop-1280 --shard=${{ matrix.shard }}/3', 'actions/upload-artifact']);
    expect(steps.find((step) => step.uses?.startsWith('actions/cache'))?.with).toEqual({ path: '~/.cache/ms-playwright', key: `playwright-${playwrightVersion}-\${{ runner.os }}` });
    expect(steps.at(-1)?.with).toEqual({ name: 'ux-report-${{ matrix.shard }}', path: 'tools/ux/playwright-report', 'if-no-files-found': 'ignore' });
    expect(Object.keys(rootScripts)).toContain('test:ux');
  });

  it('runs the benchmark project alone, as the last project, on a job of its own with the same setup', () => {
    const steps = workflow.jobs['ux-benchmark']?.steps ?? [];
    expect(steps.map((step) => step.uses?.split('@')[0] ?? step.run)).toEqual([...UX_BUILD_STEPS, 'pnpm test:ux --project=benchmark --no-deps', 'actions/upload-artifact']);
    expect(steps.at(-1)?.with).toEqual({ name: 'ux-report-benchmark', path: 'tools/ux/playwright-report', 'if-no-files-found': 'ignore' });
  });

  it('holds the browser tests of every ux job to the limits of the runner, selected by name and not by the CI variable', () => {
    expect(workflow.jobs['ux']?.env).toEqual({ NEBURYX_UX_PROFILE: 'runner' });
    expect(workflow.jobs['ux-benchmark']?.env).toEqual({ NEBURYX_UX_PROFILE: 'runner' });
  });

  it('installs the browser without the system packages, whose apt download of fonts took ten minutes on a slow mirror, and gives the install a limit of its own', () => {
    for (const name of ['ux', 'ux-benchmark']) {
      const install = (workflow.jobs[name]?.steps ?? []).find((step) => step.run?.includes('playwright install'));
      expect(install?.run).not.toContain('--with-deps');
      expect(install?.['timeout-minutes']).toBe(10);
    }
  });
});
