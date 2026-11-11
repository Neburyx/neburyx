import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { repoRoot } from './workspace.js';

const stepSchema = z.object({
  name: z.string().optional(),
  id: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
const jobSchema = z.object({
  'runs-on': z.string(),
  'timeout-minutes': z.number().optional(),
  permissions: z.unknown().optional(),
  steps: z.array(stepSchema),
});
const workflowSchema = z.object({
  on: z.record(z.string(), z.unknown()),
  permissions: z.record(z.string(), z.string()),
  jobs: z.record(z.string(), jobSchema),
});
const pushSchema = z.object({ tags: z.array(z.string()).optional(), branches: z.array(z.string()).optional() });
type Workflow = z.infer<typeof workflowSchema>;
type Step = z.infer<typeof stepSchema>;

const workflowText = readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
const readmeText = readFileSync(join(repoRoot, 'deploy', 'release', 'README.md'), 'utf8');
const RUNNER = 'ubuntu-26.04';
const TAG_GLOB = 'v[0-9]*.[0-9]*.[0-9]*';
const pinnedAction = /^[\w-]+\/[\w-]+@v\d+\.\d+\.\d+$/;
const PUSH_LINE = 'node deploy/release/release-image.mjs --tag "$GITHUB_REF_NAME" --push';
const CHECK_LINE = 'node deploy/release/release-image.mjs --tag "$GITHUB_REF_NAME" --check-target';
const REGISTRY_HOST = /\b(ghcr\.io|docker\.io|quay\.io|gcr\.io|amazonaws\.com|azurecr\.io)\b/;
const WRITERS = /(git\s+(push|tag|commit|config)|\bgh\s|create-release|action-gh-release|GIT_AUTHOR|GIT_COMMITTER|user\.(name|email))/;

function parseWorkflow(text: string): Workflow {
  return workflowSchema.parse(parse(text));
}

function stepsOf(workflow: Workflow): Step[] {
  return Object.values(workflow.jobs).flatMap((job) => job.steps);
}

function firstJob(workflow: Workflow) {
  const job = Object.values(workflow.jobs)[0];
  if (job === undefined) throw new Error('the workflow has no job');
  return job;
}

function stepText(step: Step): string {
  return `${step.run ?? ''}\n${step.uses ?? ''}\n${JSON.stringify(step.with ?? {})}\n${JSON.stringify(step.env ?? {})}`;
}

function startsWith(prefix: string): (step: Step) => boolean {
  return (step) => step.uses?.startsWith(prefix) === true;
}

function runIncludes(text: string): (step: Step) => boolean {
  return (step) => (step.run ?? '').includes(text);
}

function violations(workflow: Workflow): string[] {
  const found: string[] = [];
  const triggers = Object.keys(workflow.on);
  const push = pushSchema.safeParse(workflow.on['push']);
  if (triggers.length !== 1 || triggers[0] !== 'push') found.push('trigger');
  else if (!push.success || JSON.stringify(push.data.tags) !== JSON.stringify([TAG_GLOB]) || push.data.branches !== undefined) found.push('trigger');
  const jobs = Object.values(workflow.jobs);
  if (JSON.stringify(workflow.permissions) !== JSON.stringify({ contents: 'read' }) || jobs.some((job) => job.permissions !== undefined)) {
    found.push('permissions');
  }
  const steps = stepsOf(workflow);
  if (steps.some((step) => step.uses !== undefined && !pinnedAction.test(step.uses))) found.push('pinning');
  if (jobs.some((job) => job['runs-on'] !== RUNNER)) found.push('runner');
  if (jobs.some((job) => job['timeout-minutes'] === undefined)) found.push('timeout');
  const checkout = steps.find(startsWith('actions/checkout@'));
  if (checkout?.with?.['persist-credentials'] !== false || checkout.with['fetch-depth'] !== 0) found.push('checkout');
  if (steps.some(startsWith('actions/cache@'))) found.push('cache');
  const order = [
    steps.findIndex(startsWith('actions/checkout@')),
    steps.findIndex((step) => step.run === 'pnpm install --frozen-lockfile'),
    steps.findIndex(startsWith('docker/setup-qemu-action@')),
    steps.findIndex(startsWith('docker/setup-buildx-action@')),
    steps.findIndex((step) => step.run === 'pnpm test:image'),
    steps.findIndex(runIncludes('skopeo --version')),
    steps.findIndex(runIncludes('--check-target')),
    steps.findIndex(startsWith('docker/login-action@')),
    steps.findIndex(runIncludes('--push')),
  ];
  const [, , , , , , targetAt = -1, loginAt = -1, pushAt = -1] = order;
  const inOrder = order.every((position, at) => position >= 0 && (at === 0 || position > (order[at - 1] ?? -1)));
  if (!inOrder || pushAt !== steps.length - 1 || loginAt !== steps.length - 2) found.push('order');
  if (steps.some((step, at) => ((step.run ?? '').includes('--push') || (step.run ?? '').includes('skopeo copy')) && at !== pushAt)) found.push('order');
  if (!(steps[targetAt]?.run ?? '').includes(CHECK_LINE) || !(steps[pushAt]?.run ?? '').includes(PUSH_LINE)) found.push('commands');
  if (steps.some((step) => WRITERS.test(stepText(step)))) found.push('writers');
  const loginWith = JSON.stringify(steps[loginAt]?.with ?? {});
  if (!loginWith.includes('secrets.REGISTRY_USERNAME') || !loginWith.includes('secrets.REGISTRY_TOKEN')) found.push('credentials');
  if (steps.some((step) => (step.run ?? '').includes('secrets.'))) found.push('credentials');
  const registry = steps[loginAt]?.with?.['registry'];
  if (registry !== '${{ steps.target.outputs.registry }}' || steps[targetAt]?.id !== 'target') found.push('registry-output');
  if (!(steps[pushAt]?.run ?? '').includes('GITHUB_STEP_SUMMARY')) found.push('summary');
  if (REGISTRY_HOST.test(JSON.stringify(workflow))) found.push('registry-host');
  return [...new Set(found)];
}

function copyOf(): Workflow {
  return parseWorkflow(workflowText);
}

describe('release workflow', () => {
  it('breaks none of the rules', () => {
    expect(violations(copyOf())).toEqual([]);
  });

  it('runs on a push of a version tag and on nothing else', () => {
    const workflow = copyOf();
    expect(Object.keys(workflow.on)).toEqual(['push']);
    expect(workflow.on['push']).toEqual({ tags: [TAG_GLOB] });
  });

  it('asks only for read access to the contents, in no job beyond that', () => {
    const workflow = copyOf();
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(Object.values(workflow.jobs).filter((job) => job.permissions !== undefined)).toEqual([]);
  });

  it('names a runner image and a timeout for every job and pins every action', () => {
    const workflow = copyOf();
    expect(Object.values(workflow.jobs).filter((job) => job['runs-on'] !== RUNNER || job['timeout-minutes'] === undefined)).toEqual([]);
    expect(stepsOf(workflow).flatMap((step) => step.uses ?? []).filter((action) => !pinnedAction.test(action))).toEqual([]);
  });

  it('checks out the full history without keeping the credentials, and caches nothing', () => {
    const steps = stepsOf(copyOf());
    expect(steps.find(startsWith('actions/checkout@'))?.with).toEqual({ 'fetch-depth': 0, 'persist-credentials': false });
    expect(steps.filter(startsWith('actions/cache@'))).toEqual([]);
  });

  it('keeps the login and the push last, with the target check before the login', () => {
    const steps = stepsOf(copyOf());
    expect(steps.at(-2)?.uses).toMatch(/^docker\/login-action@/);
    expect(steps.at(-1)?.run).toContain(PUSH_LINE);
    expect(steps.findIndex(runIncludes('--check-target'))).toBeLessThan(steps.length - 2);
  });

  it('reads the registry host from the target check and the credentials from two secrets', () => {
    const steps = stepsOf(copyOf());
    expect(steps.at(-2)?.with).toEqual({
      registry: '${{ steps.target.outputs.registry }}',
      username: '${{ secrets.REGISTRY_USERNAME }}',
      password: '${{ secrets.REGISTRY_TOKEN }}',
    });
    expect(steps.filter(runIncludes('secrets.'))).toEqual([]);
  });

  it('writes the image reference and digest to the run summary', () => {
    expect(stepsOf(copyOf()).at(-1)?.run).toContain('GITHUB_STEP_SUMMARY');
  });

  it('updates the package index before it installs skopeo', () => {
    const step = stepsOf(copyOf()).find(runIncludes('skopeo --version'));
    expect(step?.run).toMatch(/apt-get update && sudo apt-get install --yes skopeo/);
  });

  it('names no registry host and sets no Git identity', () => {
    expect(workflowText).not.toMatch(REGISTRY_HOST);
    expect(workflowText).not.toMatch(/git\s+config|GIT_AUTHOR|GIT_COMMITTER|user\.name|user\.email/);
  });

  const loginIndex = (workflow: Workflow) => stepsOf(workflow).findIndex(startsWith('docker/login-action@'));
  const mutations: ReadonlyArray<readonly [string, string, (workflow: Workflow) => void]> = [
    ['a pull_request trigger', 'trigger', (w) => void (w.on['pull_request'] = {})],
    ['a manual trigger', 'trigger', (w) => void (w.on['workflow_dispatch'] = {})],
    ['a branch trigger', 'trigger', (w) => void (w.on['push'] = { tags: [TAG_GLOB], branches: ['main'] })],
    ['a wider tag glob', 'trigger', (w) => void (w.on['push'] = { tags: ['v*'] })],
    ['write permission at the top', 'permissions', (w) => void (w.permissions['packages'] = 'write')],
    ['write permission in a job', 'permissions', (w) => void (firstJob(w).permissions = { packages: 'write' })],
    ['an unpinned action', 'pinning', (w) => void patchStep(w, 0, { uses: 'actions/checkout@v7' })],
    ['a default runner', 'runner', (w) => void (firstJob(w)['runs-on'] = 'ubuntu-latest')],
    ['no timeout', 'timeout', (w) => void delete firstJob(w)['timeout-minutes']],
    ['kept credentials', 'checkout', (w) => void patchStep(w, 0, { with: { 'fetch-depth': 0 } })],
    ['a shallow checkout', 'checkout', (w) => void patchStep(w, 0, { with: { 'persist-credentials': false } })],
    ['a cache step', 'cache', (w) => void firstJob(w).steps.splice(3, 0, { uses: 'actions/cache@v4.2.3' })],
    ['a push before the login', 'order', (w) => void firstJob(w).steps.splice(5, 0, { run: PUSH_LINE })],
    ['a skopeo copy before the login', 'order', (w) => void firstJob(w).steps.splice(5, 0, { run: 'skopeo copy a b' })],
    ['a step after the push', 'order', (w) => void firstJob(w).steps.push({ run: 'echo done' })],
    ['a git push step', 'writers', (w) => void firstJob(w).steps.splice(4, 0, { run: 'git push origin main' })],
    ['a git tag step', 'writers', (w) => void firstJob(w).steps.splice(4, 0, { run: 'git tag v9.9.9' })],
    ['a gh call', 'writers', (w) => void firstJob(w).steps.splice(4, 0, { run: 'gh release create v1' })],
    ['a release action', 'writers', (w) => void firstJob(w).steps.splice(4, 0, { uses: 'softprops/action-gh-release@v2.0.0' })],
    ['a Git identity', 'writers', (w) => void firstJob(w).steps.splice(4, 0, { run: 'git config user.name bot' })],
    ['a secret in a run line', 'credentials', (w) => void firstJob(w).steps.splice(4, 0, { run: 'echo ${{ secrets.REGISTRY_TOKEN }}' })],
    ['a literal registry host', 'registry-output', (w) => void patchStep(w, loginIndex(w), { with: { registry: 'registry.example', username: '${{ secrets.REGISTRY_USERNAME }}', password: '${{ secrets.REGISTRY_TOKEN }}' } })],
    ['a registry host from a known provider', 'registry-host', (w) => void patchStep(w, loginIndex(w), { with: { registry: 'ghcr.io', username: '${{ secrets.REGISTRY_USERNAME }}', password: '${{ secrets.REGISTRY_TOKEN }}' } })],
    ['a target check without its id', 'registry-output', (w) => void patchStep(w, firstJob(w).steps.findIndex(runIncludes('--check-target')), { id: 'other' })],
    ['no summary', 'summary', (w) => void patchStep(w, firstJob(w).steps.length - 1, { run: PUSH_LINE })],
  ];

  describe.each(mutations)('a copy with %s', (_label, rule, change) => {
    it(`breaks the ${rule} rule`, () => {
      const workflow = copyOf();
      change(workflow);
      expect(violations(workflow)).toContain(rule);
    });
  });
});

function patchStep(workflow: Workflow, index: number, patch: Partial<Step>): void {
  const steps = firstJob(workflow).steps;
  const step = steps[index];
  if (step === undefined) throw new Error(`no step ${index}`);
  steps[index] = { ...step, ...patch };
}

describe('the local dry run in the README', () => {
  const blocks = [...readmeText.matchAll(/```bash\n([^\n]+)\n```/g)].map((match) => match[1] ?? '');
  const runs = stepsOf(copyOf()).flatMap((step) => step.run ?? []);

  it('documents the same commands the workflow runs before the login, and the script in dry-run mode', () => {
    expect(blocks).toEqual(['pnpm install --frozen-lockfile', 'pnpm test:image', 'node deploy/release/release-image.mjs --tag v0.1.0 --dry-run']);
    expect(runs).toContain(blocks[0]);
    expect(runs).toContain(blocks[1]);
    expect(PUSH_LINE.replace('"$GITHUB_REF_NAME"', 'v0.1.0').replace('--push', '--dry-run')).toBe(blocks[2]);
  });

  it('says nothing is pushed or logged in', () => {
    expect(readmeText).toContain('no push, no login and no `skopeo` call');
  });
});
