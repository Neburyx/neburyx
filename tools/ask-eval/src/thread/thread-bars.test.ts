import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import type { EvalHooks } from '../hooks.js';
import { checkBars, textDecision, unblind, type Bars } from './report.js';
import type { Score, ScoreFile } from './scorer.js';

const entries = (repeats: number, turns: number) => Array.from({ length: repeats * turns }, (_, index) => ({ repeat: Math.floor(index / turns) + 1, turn: (index % turns) + 1, labels: { A: 'arm-refs', B: 'arm-text' } }));
const KEY = { entries: entries(3, 2) };
const scoresFor = (repeat: number, scorer: string, bits: Record<string, [0 | 1, 0 | 1, 0 | 1, 0 | 1]>): ScoreFile => ({
  scorer,
  origin: 'harness',
  scores: [1, 2].flatMap((turn) => ['A', 'B'].map((label): Score => ({ repeat, turn, label, c1: bits[label]?.[0] ?? 0, c2: bits[label]?.[1] ?? 0, c3: bits[label]?.[2] ?? 0, c4: bits[label]?.[3] ?? 0 }))),
});
const BARS: Bars = { threadMedian: 6, plans: { right: 183, of: 185, bar: 182 }, refusals: { refused: 29, of: 29 }, regressions: [{ set: 'ask', now: 30, baseline: 30 }] };

describe('the unblinded figures', () => {
  it('sums C1 to C4 per arm and repeat, takes the median over repeats and counts per criterion', () => {
    const files = [scoresFor(1, 'codex', { A: [1, 1, 1, 1], B: [1, 0, 1, 0] }), scoresFor(2, 'codex', { A: [1, 1, 1, 0], B: [0, 0, 0, 0] }), scoresFor(3, 'codex', { A: [1, 1, 0, 0], B: [1, 1, 1, 1] })];
    const arms = unblind(files, KEY, { primary: 'codex', indicativeScorers: [] });
    const refs = arms.find((arm) => arm.arm === 'arm-refs');
    expect(refs?.repeats.map((entry) => entry.total)).toEqual([8, 6, 4]);
    expect(refs?.median).toBe(6);
    expect(refs?.criteria).toEqual({ c1: 6, c2: 6, c3: 4, c4: 2 });
    expect(arms.find((arm) => arm.arm === 'arm-text')?.median).toBe(4);
  });

  it('marks a repeat scored by another scorer indicative and never counts it toward the verdict of the bar, even when counting it would change the verdict', () => {
    const files = [scoresFor(1, 'codex', { A: [0, 0, 0, 0], B: [0, 0, 0, 0] }), scoresFor(2, 'codex', { A: [1, 0, 0, 0], B: [0, 0, 0, 0] }), scoresFor(3, 'opus', { A: [1, 1, 1, 1], B: [1, 1, 1, 1] })];
    const arms = unblind(files, KEY, { primary: 'codex', indicativeScorers: ['opus'] });
    const refs = arms.find((arm) => arm.arm === 'arm-refs');
    expect(refs?.repeats.map((entry) => [entry.counted, entry.indicative])).toEqual([[true, false], [true, false], [false, true]]);
    // with the Opus repeat the median is 2, without it 1 (the Codex repeats only)
    expect(refs?.median).toBe(2);
    expect(refs?.countedMedian).toBe(1);
    const report = checkBars(arms, 'arm-refs', { ...BARS, threadMedian: 2 });
    expect(report.status).toBe('open');
    expect(report.findings[0]).toMatchObject({ bar: 'thread rubric', kind: 'below the trial median' });
  });
});

describe('the bars', () => {
  const arms = (median: number) => unblind([scoresFor(1, 'codex', { A: [1, 1, 1, 1], B: [0, 0, 0, 0] })], { entries: entries(1, 2) }, { primary: 'codex', indicativeScorers: [] }).map((arm) => ({ ...arm, countedMedian: arm.arm === 'arm-refs' ? median : arm.countedMedian }));

  it('says below, at or above for each bar, writes a miss as an open finding with its kind and place and no wording, and keeps the status open', () => {
    const below = checkBars(arms(5), 'arm-refs', { ...BARS, plans: { right: 181, of: 185, bar: 182 }, refusals: { refused: 28, of: 29 }, regressions: [{ set: 'summary', now: 10, baseline: 12 }] });
    expect(below.status).toBe('open');
    expect(below.findings.map((finding) => finding.bar)).toEqual(['thread rubric', 'plans', 'refusals', 'regression summary']);
    expect(below.lines.join('\n')).toMatch(/median 5 .* against 6: below/u);
    expect(JSON.stringify(below.findings)).not.toMatch(/sentence|answer text/iu);
    const at = checkBars(arms(6), 'arm-refs', BARS);
    expect(at.lines[0]).toMatch(/against 6: at/u);
    expect(at.status).toBe('met');
    expect(checkBars(arms(7), 'arm-refs', BARS).lines[0]).toMatch(/above/u);
  });
});

describe('the text decision', () => {
  const figure = (arm: string, median: number, c4: number) => ({ arm, repeats: [], median, countedMedian: median, criteria: { c1: 0, c2: 0, c3: 0, c4 }, turns: 0 });
  it('adopts text only at or above references with a C4 that is not lower; otherwise references stay; with no text arm it says so', () => {
    expect(textDecision([figure('r', 39, 7), figure('t', 41, 7)], 'r', 't')).toContain('adopted');
    expect(textDecision([figure('r', 39, 7), figure('t', 39, 7)], 'r', 't')).toContain('adopted');
    expect(textDecision([figure('r', 39, 7), figure('t', 41, 6)], 'r', 't')).toContain('references stay');
    expect(textDecision([figure('r', 39, 7), figure('t', 38, 9)], 'r', 't')).toContain('references stay');
    expect(textDecision([figure('r', 39, 7)], 'r', 't')).toBe('text arm not run: references stay');
  });
});

describe('the report command', () => {
  it('exits 1 and names the finding when a bar is missed, and 0 when every figure is at or above', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-bars-'));
    writeFileSync(join(dir, 'key.json'), JSON.stringify({ key: { entries: entries(1, 2) } }));
    writeFileSync(join(dir, 'scores.json'), JSON.stringify(scoresFor(1, 'codex', { A: [1, 1, 1, 1], B: [0, 0, 0, 0] })));
    const run = async (bars: Bars) => {
      writeFileSync(join(dir, 'bars.json'), JSON.stringify(bars));
      const out: string[] = [];
      const code = await runCli(['thread', 'report', '--key-file', join(dir, 'key.json'), '--bars', join(dir, 'bars.json'), '--primary', 'codex', '--product', 'arm-refs', '--text-arm', 'arm-text', join(dir, 'scores.json')], { out: (line) => out.push(line), err: () => undefined, env: {} }, {} as unknown as EvalHooks);
      return { code, out };
    };
    const miss = await run({ ...BARS, threadMedian: 9 });
    expect(miss.code).toBe(1);
    expect(miss.out.join('\n')).toContain('finding: thread rubric');
    expect(miss.out.join('\n')).toContain('decision: ');
    expect((await run(BARS)).code).toBe(0);
  });
});
