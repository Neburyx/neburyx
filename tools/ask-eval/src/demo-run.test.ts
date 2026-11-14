import net from 'node:net';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { checkRecording } from '../../../ee/ask/src/testing/recording.js';
import type { PlannerModule } from './types.js';
import { createEvalPlanner } from '../../../ee/ask/dist/eval/replay-planner.js';
import { EXIT_MISS, EXIT_OK, EXIT_USAGE, runCli } from './cli.js';
import { KNOWN_BLOCKED } from './testing/known-blocked.js';
import { reportSchema } from './groups.js';
import { parseReplay } from './replay.js';
import { PLAN_TEMPLATE_VERSION } from './replay-writer.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const QUESTIONS = join(ROOT, 'services', 'api', 'tests', 'ask', 'questions.yaml');
const PACKS = join(ROOT, 'domain-packs');
const PLANNER: PlannerModule = { createEvalPlanner };
const dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ask-eval-demo-'));
  dirs.push(dir);
  return dir;
}

async function cli(args: readonly string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli([...args], { out: (line) => void out.push(line), err: (line) => void err.push(line) }, PLANNER);
  return { code, out, err };
}

const planOf = (text: string): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(JSON.parse(text));
const base = (replay: string) => ['--questions', QUESTIONS, '--replay', replay, '--packs', PACKS];

afterEach(() => vi.restoreAllMocks());
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('the whole demo set', () => {
  it('runs on a replay made from its own expected plans: every question the allowlist lets through is scored right, the known blocked ones are listed by id, refusals and plans are two lines, and no socket is opened', async () => {
    const connect = vi.spyOn(net.Socket.prototype, 'connect');
    const dir = workspace();
    const replay = join(dir, 'replay.json');
    expect((await cli([...base(replay), '--write-replay'])).code).toBe(EXIT_OK);
    const result = await cli(base(replay));
    expect(result.code).toBe(EXIT_OK);
    expect(result.out.slice(0, 5)).toEqual(['refusals: 8 of 8 refused', 'plans: 25 of 25 right (at most 2 may miss)', 'family: 8 of 8 as expected', 'blocked: 0 of 0 expected', 'repaired: 0']);
    for (const id of KNOWN_BLOCKED) expect(result.out).toContain(`blocked-unexpectedly: ${id}`);
    expect(result.out.some((line) => line.startsWith('target missed'))).toBe(false);
    expect(result.out).toContain('answered unsupported: 8 of 33');
    expect(connect).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual(['replay.json']);
    const json = await cli([...base(replay), '--json']);
    expect(json.out).toHaveLength(1);
    const parsed = reportSchema.safeParse(JSON.parse(json.out[0] ?? ''));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.summary).toMatchObject({ refusals: { total: 8, refused: 8 }, plans: { total: 25, right: 25, maxMisses: 2 }, targets: { refusalsMet: true, plansMet: true, blockedMet: true } });
  });

  it('writes a replay that holds no identifier or personal-data-like token, and one reply for each question', async () => {
    const dir = workspace();
    const replay = join(dir, 'replay.json');
    await cli([...base(replay), '--write-replay']);
    const written = parseReplay(readFileSync(replay, 'utf8'));
    expect(Object.keys(written)).toHaveLength(33 - KNOWN_BLOCKED.length);
    const entries = Object.values(written).map((entry) => ({ promptId: 'ask.plan' as const, version: 3, reply: { kind: 'ok' as const, text: entry.plan } }));
    expect(checkRecording({ format: 1, entries })).toEqual([]);
  });

  it('runs on the committed replay and baseline: every refusal refused, every plan right, no run below the baseline of either mode, and no identifier or personal-data-like token in it', async () => {
    const replay = join(ROOT, 'services', 'api', 'tests', 'ask', 'replies.json');
    const baseline = join(ROOT, 'services', 'api', 'tests', 'ask', 'baseline.json');
    for (const mode of ['replay', 'live']) {
      const result = await cli([...base(replay), '--baseline', baseline, '--mode', mode]);
      expect(result.code).toBe(EXIT_OK);
      expect(result.out.slice(0, 3)).toEqual(['refusals: 8 of 8 refused', 'plans: 25 of 25 right (at most 2 may miss)', 'family: 8 of 8 as expected']);
    }
    const entries = Object.values(parseReplay(readFileSync(replay, 'utf8'))).flatMap((entry) => [entry.plan, ...(entry.repair === undefined ? [] : [entry.repair])]).map((text) => ({ promptId: 'ask.plan' as const, version: 7, reply: { kind: 'ok' as const, text } }));
    expect(checkRecording({ format: 1, entries })).toEqual([]);
  });

  it('accepts the template version the planner expects, so a changed catalog version fails here', () => {
    expect(PLAN_TEMPLATE_VERSION).toBe(1);
  });

  it('refuses to replace a replay that differs unless it is forced', async () => {
    const dir = workspace();
    const replay = join(dir, 'replay.json');
    writeFileSync(replay, '{}\n');
    const refused = await cli([...base(replay), '--write-replay']);
    expect(refused.code).toBe(EXIT_USAGE);
    expect(readFileSync(replay, 'utf8')).toBe('{}\n');
    expect((await cli([...base(replay), '--write-replay', '--force'])).code).toBe(EXIT_OK);
    expect(existsSync(replay)).toBe(true);
    expect(await cli([...base(replay), '--write-replay'])).toMatchObject({ code: EXIT_OK });
  });

  it('scores a changed direction wrong, an omitted default right and a refusal that got a plan as wrongly planned', async () => {
    const dir = workspace();
    const path = join(dir, 'replay.json');
    await cli([...base(path), '--write-replay']);
    const replay: Record<string, { plan: string }> = { ...parseReplay(readFileSync(path, 'utf8')) };
    const edit = (marker: string, change: (plan: Record<string, unknown>) => Record<string, unknown>) => {
      const key = Object.keys(replay).find((text) => text.includes(marker));
      if (key === undefined) throw new Error(`no question with ${marker}`);
      const current = replay[key];
      if (current === undefined) throw new Error('no reply');
      replay[key] = { plan: JSON.stringify(change(planOf(current.plan))) };
    };
    edit('sent money to', (plan) => ({ ...plan, params: { ...Object(plan['params']), direction: 'out' } }));
    edit('transferred money to', (plan) => ({ ...plan, params: Object.fromEntries(Object.entries(Object(plan['params'])).filter(([key]) => key !== 'direction')) }));
    edit('Is ‹account#1› fraudulent', () => ({ kind: 'plan', templateId: 'entity', templateVersion: 1, params: { ref: { entityType: 'account', stableId: '‹account#1›' } }, rationale: 'It names one.' }));
    writeFileSync(path, JSON.stringify(replay));
    const result = await cli(base(path));
    expect(result.code).not.toBe(EXIT_OK);
    expect(result.out).toContain('wrong: accounts-that-paid-an-account (direction)');
    expect(result.out).toContain('wrongly-planned: is-an-account-fraudulent');
    expect(result.out.some((line) => line.includes('accounts-paid-by-an-account'))).toBe(false);
    expect(result.out).toContain('plans: 24 of 25 right (at most 2 may miss)');
    expect(result.out).toContain('refusals: 7 of 8 refused');
  });
});
