import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import type { EvalHooks } from '../hooks.js';
import { checkBars, textDecision, unblind, type ArmFigures, type Bars, type KeyFile } from './report.js';
import type { Calibration } from './schemas.js';
import type { Score, ScoreFile } from './scorer.js';

type Bits = [0 | 1, 0 | 1, 0 | 1, 0 | 1];
const shaOf = (repeat: number): string => String(repeat).repeat(64).slice(0, 64).replace(/[^0-9a-f]/gu, 'a');
const keyOf = (repeats: number, turns: number, noAnswer: string[] = []): KeyFile => {
  const numbers = Array.from({ length: repeats }, (_, index) => index + 1);
  return {
    key: { entries: numbers.flatMap((repeat) => Array.from({ length: turns }, (_, index) => ({ repeat, turn: index + 1, labels: { A: 'arm-refs', B: 'arm-text' } }))), sets: Object.fromEntries(numbers.map((repeat) => [String(repeat), shaOf(repeat)])), noAnswer },
    slots: numbers.flatMap((repeat) => Array.from({ length: turns }, (_, index) => ['A', 'B'].map((label) => ({ repeat, turn: index + 1, label }))).flat()),
  };
};
const scoresFor = (repeat: number, scorer: string, bits: Record<string, Bits>, turns = 2, over: Partial<ScoreFile> = {}): ScoreFile => ({
  scorer,
  origin: 'harness',
  repeat,
  setSha256: shaOf(repeat),
  scores: Array.from({ length: turns }, (_, index) => index + 1).flatMap((turn) => ['A', 'B'].map((label): Score => ({ repeat, turn, label, c1: bits[label]?.[0] ?? 0, c2: bits[label]?.[1] ?? 0, c3: bits[label]?.[2] ?? 0, c4: bits[label]?.[3] ?? 0 }))),
  ...over,
});
const calibration = (scorer: string, indicative: boolean, repeat = 1): Calibration => ({ repeat, setSha256: shaOf(repeat), scorers: ['codex', scorer], slots: 4, agreement: { overall: indicative ? 60 : 95, c1: 60, c2: 60, c3: 60, c4: 60 }, indicative });
const PROVENANCE = { baselineModel: 'model-x', baselineCommit: 'abc1234', baselineRun: 'run-1' };
const BARS: Bars = { threadMedian: 6, plans: { right: 183, of: 185, bar: 182 }, refusals: { refused: 29, of: 29 }, regressions: [{ set: 'ask', now: 30, baseline: 30, ...PROVENANCE }, { set: 'summary', now: 12, baseline: 12, ...PROVENANCE }] };

describe('the unblinded figures', () => {
  it('sums C1 to C4 per arm and repeat, takes the median over repeats and counts per criterion', () => {
    const files = [scoresFor(1, 'codex', { A: [1, 1, 1, 1], B: [1, 0, 1, 0] }), scoresFor(2, 'codex', { A: [1, 1, 1, 0], B: [0, 0, 0, 0] }), scoresFor(3, 'codex', { A: [1, 1, 0, 0], B: [1, 1, 1, 1] })];
    const arms = unblind(files, keyOf(3, 2), [], 'codex');
    const refs = arms.find((arm) => arm.arm === 'arm-refs');
    expect(refs?.repeats.map((entry) => entry.total)).toEqual([8, 6, 4]);
    expect(refs?.median).toBe(6);
    expect(refs?.criteria).toEqual({ c1: 6, c2: 6, c3: 4, c4: 2 });
    expect(arms.find((arm) => arm.arm === 'arm-text')?.median).toBe(4);
  });

  it('gives a slot with no answer no point whatever a scorer said, at reporting as well as at scoring', () => {
    const arms = unblind([scoresFor(1, 'codex', { A: [1, 1, 1, 1], B: [1, 1, 1, 1] })], keyOf(1, 2, ['1/1/A', '1/2/A']), [], 'codex');
    expect(arms.find((arm) => arm.arm === 'arm-refs')?.repeats[0]?.total).toBe(0);
    expect(arms.find((arm) => arm.arm === 'arm-text')?.repeats[0]?.total).toBe(8);
  });

  it('refuses scores that are given twice, for another set, that do not cover the set exactly, or that leave a repeat without scores', () => {
    const key = keyOf(2, 2);
    const good = (repeat: number) => scoresFor(repeat, 'codex', { A: [1, 1, 1, 1] });
    expect(() => unblind([good(1), good(1), good(2)], key, [], 'codex')).toThrow(/given twice/u);
    expect(() => unblind([good(1), scoresFor(2, 'codex', {}, 2, { setSha256: 'f'.repeat(64) })], key, [], 'codex')).toThrow(/not for the set the key was made with/u);
    const partial = scoresFor(2, 'codex', { A: [1, 1, 1, 1] });
    expect(() => unblind([good(1), { ...partial, scores: partial.scores.slice(0, 2) }], key, [], 'codex')).toThrow(/do not cover the set exactly: missing score/u);
    expect(() => unblind([good(1), { ...partial, scores: [...partial.scores, partial.scores[0] as Score] }], key, [], 'codex')).toThrow(/duplicate score/u);
    expect(() => unblind([good(1)], key, [], 'codex')).toThrow(/no scores for repeat 2/u);
    const tenOfThirtySix = keyOf(3, 12);
    expect(() => unblind([scoresFor(1, 'codex', { A: [1, 1, 1, 1] }, 5)], tenOfThirtySix, [], 'codex')).toThrow(/do not cover the set exactly/u);
  });

  it('counts another scorer\'s repeat only with a calibration of this run that agrees at 90 percent, marks it indicative below, and refuses it without one', () => {
    const files = [scoresFor(1, 'codex', { A: [0, 0, 0, 0] }), scoresFor(2, 'codex', { A: [1, 0, 0, 0] }), scoresFor(3, 'opus', { A: [1, 1, 1, 1] })];
    const key = keyOf(3, 2);
    expect(() => unblind(files, key, [], 'codex')).toThrow(/need a calibration against codex/u);
    expect(() => unblind(files, key, [{ ...calibration('opus', false), setSha256: 'e'.repeat(64) }], 'codex')).toThrow(/need a calibration/u);
    const low = unblind(files, key, [calibration('opus', true)], 'codex').find((arm) => arm.arm === 'arm-refs');
    expect(low?.repeats.map((entry) => [entry.counted, entry.indicative])).toEqual([[true, false], [true, false], [false, true]]);
    expect(low?.median).toBe(2);
    expect(low?.countedMedian).toBe(1);
    const high = unblind(files, key, [calibration('opus', false)], 'codex').find((arm) => arm.arm === 'arm-refs');
    expect(high?.repeats[2]).toMatchObject({ counted: true, indicative: false });
    expect(unblind([scoresFor(1, 'codex', { A: [1, 1, 1, 1] }), scoresFor(1, 'opus', { A: [1, 1, 1, 1] })], keyOf(1, 2), [], 'codex')).toHaveLength(2);
    expect(() => unblind([scoresFor(1, 'opus', { A: [1, 1, 1, 1] }), scoresFor(1, 'other', { A: [1, 1, 1, 1] })], keyOf(1, 2), [calibration('opus', false)], 'codex')).toThrow(/several scorers and none of the primary/u);
  });
});

describe('the bars', () => {
  const armsOf = (median: number): ArmFigures[] => unblind([scoresFor(1, 'codex', { A: [1, 1, 1, 1], B: [0, 0, 0, 0] })], keyOf(1, 2), [], 'codex').map((arm) => ({ ...arm, countedMedian: arm.arm === 'arm-refs' ? median : arm.countedMedian }));

  it('says below, at or above for each bar, writes a miss as an open finding with its kind and place and no wording, and keeps the status open', () => {
    const below = checkBars(armsOf(5), 'arm-refs', { ...BARS, plans: { right: 181, of: 185, bar: 182 }, refusals: { refused: 28, of: 29 }, regressions: [{ set: 'ask', now: 30, baseline: 30, ...PROVENANCE }, { set: 'summary', now: 10, baseline: 12, ...PROVENANCE }] });
    expect(below.status).toBe('open');
    expect(below.findings.map((finding) => finding.bar)).toEqual(expect.arrayContaining(['plans', 'refusals', 'regression summary']));
    expect(below.lines.join('\n')).toMatch(/median 5 against 6: below/u);
    expect(JSON.stringify(below.findings)).not.toMatch(/sentence|answer text/iu);
    const at = checkBars(armsOf(6), 'arm-refs', BARS);
    expect(at.lines[0]).toMatch(/against 6: at/u);
    expect(at.status).toBe('met');
    expect(checkBars(armsOf(7), 'arm-refs', BARS).lines[0]).toMatch(/above/u);
  });

  it('names a missed thread point by its criterion, turn and repeat, from the counted repeats', () => {
    const arms = unblind([scoresFor(1, 'codex', { A: [1, 0, 1, 1], B: [1, 1, 1, 1] })], keyOf(1, 2), [], 'codex');
    const report = checkBars(arms, 'arm-refs', { ...BARS, threadMedian: 99 });
    expect(report.findings.filter((finding) => finding.bar === 'thread rubric').map((finding) => finding.where)).toEqual(['counted repeats', 'criterion C2 turn 1 repeat 1', 'criterion C2 turn 2 repeat 1']);
  });

  it('requires the Ask and summary regression sets, says plainly when no baseline exists and does not claim a check, and opens a finding for a baseline with no provenance', () => {
    expect(() => checkBars(armsOf(6), 'arm-refs', { ...BARS, regressions: [] })).toThrow(/no regression set ask/u);
    expect(() => checkBars(armsOf(6), 'arm-refs', { ...BARS, regressions: [BARS.regressions[0] as Bars['regressions'][number]] })).toThrow(/no regression set summary/u);
    const none = checkBars(armsOf(6), 'arm-refs', { ...BARS, regressions: [{ set: 'ask', now: 30, baseline: null, baselineModel: null, baselineCommit: null, baselineRun: null }, BARS.regressions[1] as Bars['regressions'][number]] });
    expect(none.lines.join('\n')).toContain('regression ask: no baseline exists: the regression is not checked');
    expect(none.status).toBe('met');
    const bare = checkBars(armsOf(6), 'arm-refs', { ...BARS, regressions: [{ set: 'ask', now: 30, baseline: 30, baselineModel: null, baselineCommit: 'c', baselineRun: 'r' }, BARS.regressions[1] as Bars['regressions'][number]] });
    expect(bare.findings).toEqual([{ bar: 'regression ask', figure: '30', kind: 'baseline provenance missing', where: 'set ask' }]);
  });

  it('opens a finding when no repeat is counted and when some repeats are only indicative', () => {
    const arms = unblind([scoresFor(1, 'codex', { A: [1, 1, 1, 1] }), scoresFor(2, 'opus', { A: [1, 1, 1, 1] })], keyOf(2, 2), [calibration('opus', true)], 'codex');
    const report = checkBars(arms, 'arm-refs', BARS);
    expect(report.findings.map((finding) => finding.kind)).toContain('repeats not counted');
    expect(checkBars([], 'arm-refs', BARS).findings[0]).toMatchObject({ kind: 'no figure' });
  });
});

describe('the text decision', () => {
  const figure = (arm: string, median: number, c4: number, counted: number[] = [1, 2, 3]): ArmFigures => ({ arm, repeats: counted.map((repeat) => ({ repeat, total: median, scorer: 'codex', counted: true, indicative: false })), median, countedMedian: median, criteria: { c1: 0, c2: 0, c3: 0, c4 }, countedCriteria: { c1: 0, c2: 0, c3: 0, c4 }, misses: [], turns: 0 });
  it('adopts text only at or above references with a C4 that is not lower, over the counted repeats; otherwise references stay; with no text arm it says so', () => {
    expect(textDecision([figure('r', 39, 7), figure('t', 41, 7)], 'r', 't')).toContain('adopted');
    expect(textDecision([figure('r', 39, 7), figure('t', 39, 7)], 'r', 't')).toContain('adopted');
    expect(textDecision([figure('r', 39, 7), figure('t', 41, 6)], 'r', 't')).toContain('references stay');
    expect(textDecision([figure('r', 39, 7), figure('t', 38, 9)], 'r', 't')).toContain('references stay');
    expect(textDecision([figure('r', 39, 7)], 'r', 't')).toBe('text arm not run: references stay');
    expect(textDecision([figure('r', 39, 7)], 'r', undefined)).toBe('text arm not run: references stay');
  });

  it('withholds adoption when the two arms have not the same counted repeats, or none are counted', () => {
    expect(textDecision([figure('r', 39, 7), figure('t', 50, 9, [1, 2])], 'r', 't')).toContain('adoption is withheld');
    const uncounted = { ...figure('t', 50, 9), repeats: [{ repeat: 1, total: 50, scorer: 'opus', counted: false, indicative: true }], countedMedian: undefined };
    expect(textDecision([figure('r', 39, 7), uncounted], 'r', 't')).toContain('adoption is withheld');
  });
});

describe('the report command', () => {
  it('exits 1 and names the finding when a bar is missed, 0 when every figure is at or above, and always states the text decision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-bars-'));
    const key = keyOf(1, 2);
    writeFileSync(join(dir, 'key.json'), JSON.stringify({ ...key, key: { ...key.key, seed: 's', manifestSha256: 'm' } }));
    writeFileSync(join(dir, 'scores.json'), JSON.stringify(scoresFor(1, 'codex', { A: [1, 1, 1, 1], B: [0, 0, 0, 0] })));
    const run = async (bars: unknown, extra: string[] = ['--text-arm', 'arm-text']) => {
      writeFileSync(join(dir, 'bars.json'), JSON.stringify(bars));
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli(['thread', 'report', '--key-file', join(dir, 'key.json'), '--bars', join(dir, 'bars.json'), '--primary', 'codex', '--product', 'arm-refs', ...extra, join(dir, 'scores.json')], { out: (line) => out.push(line), err: (line) => err.push(line), env: {} }, {} as unknown as EvalHooks);
      return { code, out, err };
    };
    const miss = await run({ ...BARS, threadMedian: 9 });
    expect(miss.code).toBe(1);
    expect(miss.out.join('\n')).toContain('finding: thread rubric');
    expect(miss.out.join('\n')).toContain('decision: ');
    const met = await run(BARS, []);
    expect(met.code).toBe(0);
    expect(met.out.join('\n')).toContain('decision: text arm not run: references stay');
    expect((await run({ ...BARS, plans: { right: 190, of: 185, bar: 182 } })).code).toBe(2);
    expect((await run({ ...BARS, regressions: [] })).code).toBe(2);
    expect((await run({ ...BARS, unknown: 1 })).code).toBe(2);
  });
});
