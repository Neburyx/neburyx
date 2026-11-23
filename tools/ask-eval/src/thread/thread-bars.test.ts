import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import type { EvalHooks } from '../hooks.js';
import { c5Of, checkBars, textDecision, unblind, validateKey, type ArmFigures, type C5 } from './report.js';
import type { Bars, Calibration, KeyFile, Score, ScoreFile } from './schemas.js';

type Bits = [0 | 1, 0 | 1, 0 | 1, 0 | 1];
const shaOf = (repeat: number): string => String(repeat).repeat(64).slice(0, 64).replace(/[^0-9a-f]/gu, 'a');
const keyOf = (repeats: number, turns: number, noAnswer: string[] = []): KeyFile => {
  const numbers = Array.from({ length: repeats }, (_, index) => index + 1);
  return {
    key: { entries: numbers.flatMap((repeat) => Array.from({ length: turns }, (_, index) => ({ repeat, turn: index + 1, labels: { A: 'arm-refs', B: 'arm-text' } }))), seed: 's', manifestSha256: 'm', sets: Object.fromEntries(numbers.map((repeat) => [String(repeat), shaOf(repeat)])), noAnswer },
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
const C5_OK: C5 = { pieces: [{ repeat: 1, turn: 1, piece: 'gate', verdict: 'passed' }] };
const BARS: Bars = { repeats: 3, turns: 2, run: 1, baselineModel: 'model-x', threadMedian: 6, plans: { right: 183, of: 185, bar: 182 }, refusals: { refused: 29, of: 29 }, regressions: [{ set: 'ask', now: 30, baseline: 30, ...PROVENANCE }, { set: 'summary', now: 12, baseline: 12, ...PROVENANCE }] };

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
    const below = checkBars(armsOf(5), 'arm-refs', { ...BARS, plans: { right: 181, of: 185, bar: 182 }, refusals: { refused: 28, of: 29 }, regressions: [{ set: 'ask', now: 30, baseline: 30, ...PROVENANCE }, { set: 'summary', now: 10, baseline: 12, ...PROVENANCE }] }, C5_OK);
    expect(below.status).toBe('open');
    expect(below.findings.map((finding) => finding.bar)).toEqual(expect.arrayContaining(['plans', 'refusals', 'regression summary']));
    expect(below.lines.join('\n')).toMatch(/median 5 against 6: below/u);
    expect(JSON.stringify(below.findings)).not.toMatch(/sentence|answer text/iu);
    const at = checkBars(armsOf(6), 'arm-refs', BARS, C5_OK);
    expect(at.lines[0]).toMatch(/against 6: at/u);
    expect(at.status).toBe('met');
    expect(checkBars(armsOf(7), 'arm-refs', BARS, C5_OK).lines[0]).toMatch(/above/u);
  });

  it('names a missed thread point by its criterion, turn and repeat, from the counted repeats', () => {
    const arms = unblind([scoresFor(1, 'codex', { A: [1, 0, 1, 1], B: [1, 1, 1, 1] })], keyOf(1, 2), [], 'codex');
    const report = checkBars(arms, 'arm-refs', { ...BARS, threadMedian: 99 }, C5_OK);
    expect(report.findings.filter((finding) => finding.bar === 'thread rubric').map((finding) => finding.where)).toEqual(['counted repeats', 'criterion C2 turn 1 repeat 1', 'criterion C2 turn 2 repeat 1']);
  });

  it('requires the Ask and summary regression sets, says plainly when no baseline exists and does not claim a check, and opens a finding for a baseline with no provenance', () => {
    expect(() => checkBars(armsOf(6), 'arm-refs', { ...BARS, regressions: [] }, C5_OK)).toThrow(/no regression set ask/u);
    expect(() => checkBars(armsOf(6), 'arm-refs', { ...BARS, regressions: [BARS.regressions[0] as Bars['regressions'][number]] }, C5_OK)).toThrow(/no regression set summary/u);
    const none = checkBars(armsOf(6), 'arm-refs', { ...BARS, regressions: [{ set: 'ask', now: 30, baseline: null, baselineModel: null, baselineCommit: null, baselineRun: null }, BARS.regressions[1] as Bars['regressions'][number]] }, C5_OK);
    expect(none.lines.join('\n')).toContain('regression ask: no baseline exists: the regression is not checked');
    expect(none.status).toBe('met');
    const bare = checkBars(armsOf(6), 'arm-refs', { ...BARS, regressions: [{ set: 'ask', now: 30, baseline: 30, baselineModel: null, baselineCommit: 'c', baselineRun: 'r' }, BARS.regressions[1] as Bars['regressions'][number]] }, C5_OK);
    expect(bare.findings).toEqual([{ bar: 'regression ask', figure: '30', kind: 'baseline provenance missing or wrong', where: 'set ask' }]);
  });

  it('judges the bar on the counted repeats only, says which are indicative and names the scorers, and opens a finding when no repeat is counted', () => {
    const arms = unblind([scoresFor(1, 'codex', { A: [1, 1, 1, 1] }), scoresFor(2, 'opus', { A: [0, 0, 0, 0] })], keyOf(2, 2), [calibration('opus', true)], 'codex');
    const report = checkBars(arms, 'arm-refs', { ...BARS, repeats: 2, threadMedian: 8 }, C5_OK);
    expect(report.status).toBe('met');
    expect(report.lines.join('\n')).toContain('judged on the counted repeats 1; scorers codex, opus; indicative, not counted: repeats 2');
    expect(checkBars([], 'arm-refs', BARS, C5_OK).findings[0]).toMatchObject({ kind: 'no figure' });
  });

  it('rejects a baseline of another model, and for run 2 a baseline that is not run 1\'s', () => {
    const arms = armsOf(6);
    const regressions = (over: Partial<Bars['regressions'][number]>) => [{ ...(BARS.regressions[0] as Bars['regressions'][number]), ...over }, BARS.regressions[1] as Bars['regressions'][number]];
    expect(checkBars(arms, 'arm-refs', { ...BARS, regressions: regressions({ baselineModel: 'another' }) }, C5_OK).findings.map((finding) => finding.kind)).toEqual(['baseline provenance missing or wrong']);
    expect(checkBars(arms, 'arm-refs', { ...BARS, run: 2, regressions: regressions({ baselineRun: 'run-9' }) }, C5_OK).findings).toHaveLength(1);
    expect(checkBars(arms, 'arm-refs', { ...BARS, run: 2, regressions: BARS.regressions.map((entry) => ({ ...entry, baselineRun: 'run-1' })) }, C5_OK).status).toBe('met');
  });

  it('shows C5 as unverified when there is no evidence, shows the three pieces and the citations, and keeps the status open on a failed or unverified piece', () => {
    expect(checkBars(armsOf(6), 'arm-refs', BARS, undefined)).toMatchObject({ status: 'open', findings: [{ bar: 'C5', kind: 'no evidence' }] });
    const mixed: C5 = { pieces: [{ repeat: 1, turn: 2, piece: 'gate', verdict: 'failed' }, { repeat: 1, turn: 2, piece: 'tools offered', verdict: 'unverified' }, { repeat: 1, turn: 3, piece: 'gate', verdict: 'passed' }] };
    const report = checkBars(armsOf(6), 'arm-refs', BARS, mixed);
    expect(report.status).toBe('open');
    expect(report.lines.join('\n')).toContain('C5 gate: passed 1, failed 1, unverified 0');
    expect(report.findings.filter((finding) => finding.bar === 'C5').map((finding) => [finding.kind, finding.where])).toEqual([['failed', 'turn 2 repeat 1'], ['unverified', 'turn 2 repeat 1']]);
  });

  it('works C5 out of the evidence kept with the records: a turn with no evidence is unverified, a citation with no line fails', () => {
    const gate = { gated: { verdict: 'passed' as const, reads: 0, gateEvents: 0, failedEvents: 0 }, called: { verdict: 'passed' as const, names: [], outside: [], unparsed: 0 }, offered: { verdict: 'unverified' as const, names: [], outside: [], callsWithoutNames: 1 } };
    const turn = (n: number) => ({ n, message: 'q', traceId: `t${n}`, ms: 1, httpStatus: 200, status: 'answered' as const, answer: {} });
    const enriched = { file: { manifest: { name: 'm', sha256: 'x' }, sourceId: 'demo', repeat: 2, expectedMessages: ['q', 'q'], arm: 'a', head: 'h', settings: { model: 'm', callLimit: 7, configured: {} }, startedAt: '', endedAt: '', view: { entities: 26 }, turns: [turn(1), turn(2)], ended: 'complete' as const }, records: [undefined, undefined], evidence: [{ citations: { callNumber: 2, mapped: [], missing: ['n9'], malformed: 0 }, gate }, undefined], inconsistent: false, disagreeing: [] };
    const c5 = c5Of([enriched]);
    expect(c5.pieces.map((piece) => [piece.turn, piece.piece, piece.verdict])).toEqual([[1, 'gate', 'passed'], [1, 'tools called', 'passed'], [1, 'tools offered', 'unverified'], [1, 'citations', 'failed'], [2, 'records', 'unverified']]);
    expect(c5.pieces.every((piece) => piece.repeat === 2)).toBe(true);
  });
});

describe('the key', () => {
  const experiment = { repeats: 3, turns: 2 };
  it('accepts a key that is exactly the experiment', () => {
    expect(() => validateKey(keyOf(3, 2, ['1/1/A']), experiment)).not.toThrow();
  });

  it('refuses a key of another size, with a turn twice, slots that are not its labels, sets for other repeats, arms that change, or a no-answer slot that is not a slot', () => {
    expect(() => validateKey(keyOf(1, 2), experiment)).toThrow(/holds 1 repeats and the experiment has 3/u);
    expect(() => validateKey(keyOf(3, 1), experiment)).toThrow(/holds 1 turns and the experiment has 2/u);
    const key = keyOf(3, 2);
    expect(() => validateKey({ ...key, key: { ...key.key, entries: [...key.key.entries, key.key.entries[0] as KeyFile['key']['entries'][number]] } }, experiment)).toThrow(/twice/u);
    expect(() => validateKey({ ...key, slots: key.slots.slice(1) }, experiment)).toThrow(/slots are not exactly/u);
    expect(() => validateKey({ ...key, slots: [...key.slots.slice(1), key.slots[1] as KeyFile['slots'][number]] }, experiment)).toThrow(/slots are not exactly/u);
    expect(() => validateKey({ ...key, key: { ...key.key, sets: { ...key.key.sets, '9': shaOf(9) } } }, experiment)).toThrow(/sets for other repeats/u);
    expect(() => validateKey({ ...key, key: { ...key.key, noAnswer: ['7/7/A'] } }, experiment)).toThrow(/no-answer slot/u);
    const swapped = { ...key, key: { ...key.key, entries: key.key.entries.map((entry, index) => (index === 0 ? { ...entry, labels: { A: 'arm-refs', B: 'arm-other' } } : entry)) } };
    expect(() => validateKey(swapped, experiment)).toThrow(/other arms/u);
    const doubled = { ...key, key: { ...key.key, entries: key.key.entries.map((entry, index) => (index === 0 ? { ...entry, labels: { A: 'arm-refs', B: 'arm-refs' } } : entry)) } };
    expect(() => validateKey(doubled, experiment)).toThrow(/one arm/u);
  });

  it('refuses a calibration that contradicts itself or does not cover its set', () => {
    const files = [scoresFor(1, 'codex', { A: [1, 1, 1, 1] }), scoresFor(2, 'opus', { A: [1, 1, 1, 1] })];
    expect(() => unblind(files, keyOf(2, 2), [{ ...calibration('opus', false), slots: 3 }], 'codex')).toThrow(/does not cover its whole set/u);
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
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-bars-'));
    writeFileSync(join(dir, 'key.json'), JSON.stringify(keyOf(1, 2)));
    writeFileSync(join(dir, 'scores.json'), JSON.stringify(scoresFor(1, 'codex', { A: [1, 1, 1, 1], B: [0, 0, 0, 0] })));
    const gate = { gated: { verdict: 'passed', reads: 0, gateEvents: 0, failedEvents: 0 }, called: { verdict: 'passed', names: [], outside: [], unparsed: 0 }, offered: { verdict: 'passed', names: [], outside: [], callsWithoutNames: 0 } };
    const evidence = { citations: { callNumber: 2, mapped: [], missing: [], malformed: 0 }, gate };
    const turn = (n: number) => ({ n, message: 'q', traceId: `t${n}`, ms: 1, httpStatus: 200, status: 'answered', answer: {} });
    const file = { manifest: { name: 'm', sha256: 'x' }, sourceId: 'demo', repeat: 1, expectedMessages: ['q', 'q'], arm: 'arm-refs', head: 'h', settings: { model: 'm', callLimit: 7, configured: {} }, startedAt: '', endedAt: '', view: { entities: 26 }, turns: [turn(1), turn(2)], ended: 'complete' };
    writeFileSync(join(dir, 'evidence.json'), JSON.stringify({ file, records: [null, null], evidence: [evidence, evidence], inconsistent: false, disagreeing: [] }));
    return dir;
  };
  const run = async (dir: string, bars: unknown, extra: string[] = ['--text-arm', 'arm-text'], primary = 'codex') => {
    writeFileSync(join(dir, 'bars.json'), JSON.stringify(bars));
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['thread', 'report', '--key-file', join(dir, 'key.json'), '--bars', join(dir, 'bars.json'), '--primary', primary, '--product', 'arm-refs', '--evidence', join(dir, 'evidence.json'), ...extra, join(dir, 'scores.json')], { out: (line) => out.push(line), err: (line) => err.push(line), env: {} }, {} as unknown as EvalHooks);
    return { code, out, err };
  };
  const bars = { ...BARS, repeats: 1, turns: 2 };

  it('exits 1 and names the finding when a bar is missed, 0 when every figure is at or above, and always states the text decision', async () => {
    const dir = setup();
    const miss = await run(dir, { ...bars, threadMedian: 9 });
    expect(miss.code).toBe(1);
    expect(miss.out.join('\n')).toContain('finding: thread rubric');
    expect(miss.out.join('\n')).toContain('decision: ');
    const met = await run(dir, bars, []);
    expect(met.code).toBe(0);
    expect(met.out.join('\n')).toContain('decision: text arm not run: references stay');
    expect(met.out.join('\n')).toContain('C5 gate: passed 2, failed 0, unverified 0');
    expect((await run(dir, { ...bars, plans: { right: 190, of: 185, bar: 182 } })).code).toBe(2);
    expect((await run(dir, { ...bars, regressions: [] })).code).toBe(2);
    expect((await run(dir, { ...bars, unknown: 1 })).code).toBe(2);
  });

  it('refuses a key of another size than the bars file defines, and a primary scorer that is not codex', async () => {
    const dir = setup();
    expect((await run(dir, { ...bars, repeats: 3 })).err.join('\n')).toContain('holds 1 repeats and the experiment has 3');
    expect((await run(dir, bars, [], 'opus')).err.join('\n')).toContain('the primary scorer is codex');
  });

  it('refuses a calibration whose figures contradict each other', async () => {
    const dir = setup();
    for (const [name, body] of [['zero.json', { ...calibration('opus', false), agreement: { overall: 0, c1: 0, c2: 0, c3: 0, c4: 0 } }], ['mean.json', { ...calibration('opus', true), agreement: { overall: 50, c1: 60, c2: 60, c3: 60, c4: 60 } }], ['range.json', { ...calibration('opus', true), agreement: { overall: 120, c1: 120, c2: 120, c3: 120, c4: 120 } }]] as const) {
      writeFileSync(join(dir, name), JSON.stringify(body));
      const result = await run(dir, bars, ['--calibrations', join(dir, name)]);
      expect(result.code, name).toBe(2);
    }
  });
});
