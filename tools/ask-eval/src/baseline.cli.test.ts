import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createEvalPlanner } from '../../../ee/ask/dist/eval/replay-planner.js';
import { EXIT_MISS, EXIT_OK, EXIT_USAGE, runCli } from './cli.js';
import { parseReplay } from './replay.js';
import type { PlannerModule } from './types.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const MAPPING = join(ROOT, 'domain-packs', 'banking-fraud', 'neburyx.yaml');
const PLANNER: PlannerModule = { createEvalPlanner };
const dirs: string[] = [];

const FILE = `questions:
  - id: same-device
    pack: banking-fraud
    wording: Which accounts use the same device as ‹account#1›?
    expect: { kind: plan, template: shared-attribute, params: { ref: { entityType: account, stableId: ‹account#1› }, attributeType: device, via: USES_DEVICE } }
  - id: show-account
    pack: banking-fraud
    wording: Show me ‹account#1›.
    expect: { kind: plan, template: entity, params: { ref: { entityType: account, stableId: ‹account#1› } } }
  - id: money-out
    pack: banking-fraud
    wording: Which accounts has ‹account#1› transferred money to?
    expect: { kind: plan, template: linked-entities, params: { ref: { entityType: account, stableId: ‹account#1› }, targetType: account, via: [TRANSFERRED_TO], direction: out } }
  - id: judgement
    pack: banking-fraud
    wording: Is ‹account#1› fraudulent?
    expect: { kind: unsupported }
`;

async function cli(args: readonly string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli([...args], { out: (line) => void out.push(line), err: (line) => void err.push(line) }, PLANNER);
  return { code, out, err };
}

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'ask-eval-baseline-'));
  dirs.push(dir);
  const file = join(dir, 'questions.yaml');
  writeFileSync(file, FILE);
  const replay = join(dir, 'replay.json');
  const baseline = join(dir, 'baseline.json');
  const args = ['--questions', file, '--replay', replay, '--mapping', MAPPING, '--refusal-target', 'exact', '--max-misses', '1'];
  await cli([...args, '--write-replay', '--out', replay]);
  const withBaseline = [...args, '--baseline', baseline];
  return { dir, replay, baseline, args, withBaseline, update: [...withBaseline, '--update-baseline', '--out', baseline] };
}

function degrade(replay: string, marker: string): void {
  const data: Record<string, { plan: string }> = { ...parseReplay(readFileSync(replay, 'utf8')) };
  const key = Object.keys(data).find((text) => text.includes(marker));
  if (key === undefined) throw new Error(`no question with ${marker}`);
  data[key] = { plan: 'not a plan' };
  writeFileSync(replay, JSON.stringify(data));
}

afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('the baseline rule', () => {
  it('applies only the targets when no baseline exists for the mode, and says so', async () => {
    const { args, baseline } = await rig();
    const result = await cli([...args, '--baseline', baseline]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain('no baseline for the mode replay: only the targets apply');
  });

  it('writes the first value on request, and then keeps it when a result equals it', async () => {
    const { withBaseline, update, baseline } = await rig();
    expect((await cli(update)).code).toBe(EXIT_OK);
    const first = readFileSync(baseline, 'utf8');
    expect(JSON.parse(first)).toMatchObject({ format: 1, modes: { replay: { plansRight: 3, refusalsRefused: 1 } } });
    expect((await cli(withBaseline)).code).toBe(EXIT_OK);
    expect(readFileSync(baseline, 'utf8')).toBe(first);
  });

  it('fails below the baseline even when both targets are met, and names it', async () => {
    const { withBaseline, update, replay } = await rig();
    await cli(update);
    degrade(replay, 'Show me');
    const result = await cli(withBaseline);
    expect(result.code).toBe(EXIT_MISS);
    expect(result.out.some((line) => line.startsWith('baseline missed'))).toBe(true);
    expect(result.out.some((line) => line.startsWith('target missed'))).toBe(false);
  });

  it('refuses to write a lower value, and writes only from a run that meets its targets', async () => {
    const { withBaseline, update, replay, baseline } = await rig();
    await cli(update);
    const before = readFileSync(baseline, 'utf8');
    degrade(replay, 'Show me');
    const lower = await cli(update);
    expect(lower.code).toBe(EXIT_USAGE);
    expect(lower.err.join(' ')).toContain('only by a run that meets');
    expect(readFileSync(baseline, 'utf8')).toBe(before);
    degrade(replay, 'same device');
    expect((await cli(withBaseline)).out).toContain('target missed: more than 1 plans missed');
    expect((await cli(update)).code).toBe(EXIT_USAGE);
    expect(readFileSync(baseline, 'utf8')).toBe(before);
  });

  it('is a usage error, distinct from a miss, for a malformed baseline, an unknown format or a baseline of another question set', async () => {
    const { withBaseline, baseline } = await rig();
    for (const text of ['not json', '{"format":2,"questionsHash":"x","modes":{}}', JSON.stringify({ format: 1, questionsHash: 'a'.repeat(64), modes: {} })]) {
      writeFileSync(baseline, text);
      expect((await cli(withBaseline)).code).toBe(EXIT_USAGE);
    }
  });

  it('keeps standard output one JSON document when the baseline is written in the same run, with the verdict inside it', async () => {
    const { update } = await rig();
    const result = await cli([...update, '--json']);
    expect(result.out).toHaveLength(1);
    expect(JSON.parse(result.out[0] ?? '').summary).toMatchObject({ targets: { refusalsMet: true, plansMet: true }, baseline: { mode: 'replay', value: null, missed: false } });
    expect(result.err.join(' ')).toContain('baseline written for the mode replay');
  });

  it('fails a target with its own message when a refusal question gets a plan', async () => {
    const { args, replay } = await rig();
    const data: Record<string, { plan: string }> = { ...parseReplay(readFileSync(replay, 'utf8')) };
    const key = Object.keys(data).find((text) => text.includes('fraudulent'));
    if (key === undefined) throw new Error('no question');
    data[key] = { plan: JSON.stringify({ kind: 'plan', templateId: 'entity', templateVersion: 1, params: { ref: { entityType: 'account', stableId: '‹account#1›' } }, rationale: 'It names one.' }) };
    writeFileSync(replay, JSON.stringify(data));
    const result = await cli(args);
    expect(result.code).toBe(EXIT_MISS);
    expect(result.out).toContain('target missed: every refusal must be refused');
  });
});
