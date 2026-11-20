import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { repoRoot } from './workspace.js';

const stepSchema = z.object({ uses: z.string().optional(), run: z.string().optional(), with: z.record(z.string(), z.union([z.string(), z.number()])).optional(), env: z.record(z.string(), z.string()).optional() });
const workflowSchema = z.strictObject({
  name: z.string(),
  on: z.strictObject({ schedule: z.array(z.strictObject({ cron: z.string() })), workflow_dispatch: z.null() }),
  permissions: z.strictObject({ contents: z.literal('read') }),
  jobs: z.record(z.string(), z.strictObject({ 'runs-on': z.string(), 'timeout-minutes': z.number(), steps: z.array(stepSchema) })),
});

const text = readFileSync(join(repoRoot, '.github', 'workflows', 'ask-eval-nightly.yml'), 'utf8');
const ci = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
const workflow = workflowSchema.parse(parse(text));
const [job] = Object.values(workflow.jobs);
const rootScripts = z.object({ scripts: z.record(z.string(), z.string()) }).parse(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))).scripts;

describe('the nightly Ask evaluation workflow', () => {
  it('runs on one schedule and by hand only, never on a push or a pull request', () => {
    expect(workflow.on.schedule).toHaveLength(1);
    expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
  });

  it('can only read the repository and holds no secret or key', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/\b(?:API_KEY|TOKEN|PASSWORD)\b/i);
    expect(job?.steps.some((step) => step.env !== undefined)).toBe(false);
  });

  it('runs on the runner image and with the action versions the CI workflow pins', () => {
    expect(job?.['runs-on']).toBe('ubuntu-26.04');
    for (const step of job?.steps ?? []) {
      if (step.uses === undefined) continue;
      expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@v\d+\.\d+\.\d+$/);
      expect(ci).toContain(`uses: ${step.uses}`);
    }
    expect(job?.steps.find((step) => step.uses?.startsWith('actions/setup-node'))?.with).toEqual({ 'node-version-file': '.nvmrc' });
  });

  it('installs from the lockfile and ends by running the runner on the checked-in packs, replay and baseline files', () => {
    const runs = (job?.steps ?? []).flatMap((step) => (step.run === undefined ? [] : [step.run]));
    expect(runs.slice(0, 2)).toEqual(['corepack enable', 'pnpm install --frozen-lockfile']);
    const last = runs.find((run) => run.startsWith('pnpm ask-eval --packs')) ?? '';
    expect(last).toMatch(/^pnpm ask-eval /);
    for (const file of ['domain-packs', 'tools/ask-eval/data/replay.json', 'tools/ask-eval/data/baseline.json']) expect(last).toContain(file);
  });

  it('also replays the assistant router\'s committed replies, with no model call, key or recording', () => {
    const runs = (job?.steps ?? []).flatMap((step) => (step.run === undefined ? [] : [step.run]));
    const assistant = runs.filter((run) => run.startsWith('pnpm ask-eval assistant '));
    expect(assistant.length).toBeGreaterThanOrEqual(1);
    for (const run of assistant) {
      expect(run).toContain('--packs domain-packs');
      expect(run).toMatch(/--replay tools\/ask-eval\/data\/assistant\/[\w-]+\/replay\.json/);
      expect(run).not.toMatch(/\b(record|loop-cost|defaults)\b|--write-replay|--update-baseline|--run-record/);
    }
    expect(text).not.toContain('NEBURYX_ASK_API_KEY_FILE');
    const steps = job?.steps ?? [];
    const askAt = steps.findIndex((step) => step.run?.startsWith('pnpm ask-eval --packs') === true);
    const assistantAt = steps.findIndex((step) => step.run?.startsWith('pnpm ask-eval assistant ') === true);
    expect(askAt).toBeGreaterThan(-1);
    expect(assistantAt).toBeGreaterThan(askAt);
    expect(text).toMatch(/if: always\(\)\n\s+run: pnpm ask-eval assistant /);
  });

  it('is not named by the per-push CI workflow and its script builds what the runner needs', () => {
    expect(ci).not.toContain('ask-eval');
    expect(rootScripts['ask-eval']).toContain('--filter "@neburyx/ask-eval..." build');
  });
});
