import { UsageError } from '../questions.js';
import type { KeyEntry } from './blind.js';
import { scoreProblems, zeroNoAnswers, type ScoreFile } from './scorer.js';
import type { Calibration } from './schemas.js';

type Criterion = 'c1' | 'c2' | 'c3' | 'c4';
const CRITERIA: readonly Criterion[] = ['c1', 'c2', 'c3', 'c4'];

interface RepeatFigure {
  readonly repeat: number;
  readonly total: number;
  readonly scorer: string;
  /** Whether the repeat counts toward the bar: scored by the primary scorer, or by another whose calibration agrees at 90 percent or more. */
  readonly counted: boolean;
  readonly indicative: boolean;
}

export interface ArmFigures {
  readonly arm: string;
  readonly repeats: readonly RepeatFigure[];
  readonly median: number | undefined;
  readonly countedMedian: number | undefined;
  readonly criteria: Readonly<Record<Criterion, number>>;
  readonly countedCriteria: Readonly<Record<Criterion, number>>;
  /** The criterion, turn and repeat of every point a counted repeat did not earn. */
  readonly misses: readonly { readonly repeat: number; readonly turn: number; readonly criterion: Criterion }[];
  readonly turns: number;
}

export interface KeyFile {
  readonly key: { readonly entries: readonly KeyEntry[]; readonly sets: Readonly<Record<string, string>>; readonly noAnswer: readonly string[] };
  readonly slots: readonly { readonly repeat: number; readonly turn: number; readonly label: string }[];
}

const medianOf = (values: readonly number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/** The scores of the repeats, one file per repeat: the primary scorer's where it scored, else the one other scorer's, whose calibration against the primary decides whether it counts. */
function chosenFiles(files: readonly ScoreFile[], key: KeyFile, calibrations: readonly Calibration[], primary: string): { readonly file: ScoreFile; readonly counted: boolean; readonly indicative: boolean }[] {
  const seen = new Set<string>();
  for (const file of files) {
    const identity = `${file.scorer}/${file.repeat}`;
    if (seen.has(identity)) throw new UsageError(`the scores of ${file.scorer} for repeat ${file.repeat} were given twice`);
    seen.add(identity);
    if (key.key.sets[String(file.repeat)] !== file.setSha256) throw new UsageError(`the scores of ${file.scorer} for repeat ${file.repeat} are not for the set the key was made with`);
    const problems = scoreProblems(key.slots.filter((slot) => slot.repeat === file.repeat), file.scores);
    if (problems.length > 0) throw new UsageError(`the scores of ${file.scorer} for repeat ${file.repeat} do not cover the set exactly: ${problems[0] ?? ''}`);
  }
  const chosen: { file: ScoreFile; counted: boolean; indicative: boolean }[] = [];
  for (const repeat of Object.keys(key.key.sets).map(Number).sort((a, b) => a - b)) {
    const mine = files.filter((file) => file.repeat === repeat);
    const direct = mine.find((file) => file.scorer === primary);
    if (direct !== undefined) {
      chosen.push({ file: direct, counted: true, indicative: false });
      continue;
    }
    if (mine.length === 0) throw new UsageError(`no scores for repeat ${repeat}`);
    if (mine.length > 1) throw new UsageError(`repeat ${repeat} has scores of several scorers and none of the primary scorer ${primary}`);
    const other = mine[0];
    if (other === undefined) continue;
    const calibration = calibrations.find((entry) => entry.scorers.includes(primary) && entry.scorers.includes(other.scorer) && key.key.sets[String(entry.repeat)] === entry.setSha256);
    if (calibration === undefined) throw new UsageError(`the scores of ${other.scorer} for repeat ${repeat} need a calibration against ${primary} made on a set of this run`);
    chosen.push({ file: other, counted: !calibration.indicative, indicative: calibration.indicative });
  }
  return chosen;
}

/**
 * The scores unblinded with the key. Every file must be for the key's set (its hash), cover its slots exactly and be the only one of its scorer for the repeat; a slot with no answer scores zero whatever a scorer said; every
 * repeat of the key needs scores. The primary scorer's repeats count; another scorer's count only when its calibration against the primary agrees at 90 percent or more, and are marked indicative when it does not.
 */
export function unblind(files: readonly ScoreFile[], key: KeyFile, calibrations: readonly Calibration[], primary: string): ArmFigures[] {
  const chosen = chosenFiles(files, key, calibrations, primary);
  const byLabel = new Map<string, string>();
  for (const entry of key.key.entries) for (const [label, arm] of Object.entries(entry.labels)) byLabel.set(`${entry.repeat}/${entry.turn}/${label}`, arm);
  const noAnswer = new Set(key.key.noAnswer);
  const arms = [...new Set(byLabel.values())].sort();
  return arms.map((arm) => {
    const totals = new Map<number, { total: number; scorer: string; counted: boolean; indicative: boolean }>();
    const criteria = { c1: 0, c2: 0, c3: 0, c4: 0 };
    const countedCriteria = { c1: 0, c2: 0, c3: 0, c4: 0 };
    const misses: { repeat: number; turn: number; criterion: Criterion }[] = [];
    let turns = 0;
    for (const entry of chosen) {
      for (const score of zeroNoAnswers(entry.file.scores, noAnswer)) {
        if (byLabel.get(`${score.repeat}/${score.turn}/${score.label}`) !== arm) continue;
        const held = totals.get(score.repeat) ?? { total: 0, scorer: entry.file.scorer, counted: entry.counted, indicative: entry.indicative };
        held.total += score.c1 + score.c2 + score.c3 + score.c4;
        totals.set(score.repeat, held);
        for (const criterion of CRITERIA) {
          criteria[criterion] += score[criterion];
          if (entry.counted) {
            countedCriteria[criterion] += score[criterion];
            if (score[criterion] === 0) misses.push({ repeat: score.repeat, turn: score.turn, criterion });
          }
        }
        turns += 1;
      }
    }
    const repeats = [...totals.entries()].sort((a, b) => a[0] - b[0]).map(([repeat, held]) => ({ repeat, total: held.total, scorer: held.scorer, counted: held.counted, indicative: held.indicative }));
    return { arm, repeats, median: medianOf(repeats.map((entry) => entry.total)), countedMedian: medianOf(repeats.filter((entry) => entry.counted).map((entry) => entry.total)), criteria, countedCriteria, misses, turns };
  });
}

export interface Bars {
  /** The trial's median of the comparison arm (an external private input). */
  readonly threadMedian: number;
  readonly plans: { readonly right: number; readonly of: number; readonly bar: number };
  readonly refusals: { readonly refused: number; readonly of: number };
  /** The regression sets against their Sonnet baselines, higher is better; a baseline of `null` says none exists, and a baseline names the model, commit and run it came from. */
  readonly regressions: readonly { readonly set: string; readonly now: number; readonly baseline: number | null; readonly baselineModel: string | null; readonly baselineCommit: string | null; readonly baselineRun: string | null }[];
}

const REQUIRED_REGRESSIONS = ['ask', 'summary'];

interface Finding {
  readonly bar: string;
  readonly figure: string;
  readonly kind: string;
  readonly where: string;
}

export interface BarReport {
  readonly lines: readonly string[];
  readonly findings: readonly Finding[];
  /** `open` as long as any figure is below its bar or evidence is missing; the feature is never reported done from here. */
  readonly status: 'open' | 'met';
}

/** The bars checked: each figure against its bar, below / at or above; a figure below a bar is an open finding with its kind and place, never a wording. The bars file must name the Ask and summary regression sets. */
export function checkBars(arms: readonly ArmFigures[], product: string, bars: Bars): BarReport {
  for (const set of REQUIRED_REGRESSIONS) if (!bars.regressions.some((regression) => regression.set === set)) throw new UsageError(`the bars file has no regression set ${set}`);
  const lines: string[] = [];
  const findings: Finding[] = [];
  const figure = arms.find((entry) => entry.arm === product);
  const median = figure?.countedMedian;
  if (figure === undefined || median === undefined) {
    lines.push('thread rubric: no repeat scored by the primary scorer');
    findings.push({ bar: 'thread rubric', figure: 'none', kind: 'no figure', where: 'all repeats' });
  } else {
    const verdict = median < bars.threadMedian ? 'below' : median === bars.threadMedian ? 'at' : 'above';
    lines.push(`thread rubric: median ${median} against ${bars.threadMedian}: ${verdict}`);
    if (verdict === 'below') findings.push({ bar: 'thread rubric', figure: String(median), kind: 'below the trial median', where: 'counted repeats' });
    if (verdict === 'below') for (const miss of figure.misses) findings.push({ bar: 'thread rubric', figure: String(median), kind: 'point missed', where: `criterion ${miss.criterion.toUpperCase()} turn ${miss.turn} repeat ${miss.repeat}` });
    if (figure.repeats.some((entry) => !entry.counted)) {
      lines.push('thread rubric: some repeats are indicative and are not counted');
      findings.push({ bar: 'thread rubric', figure: String(median), kind: 'repeats not counted', where: figure.repeats.filter((entry) => !entry.counted).map((entry) => `repeat ${entry.repeat}`).join(', ') });
    }
  }
  lines.push(`plans: ${bars.plans.right} of ${bars.plans.of} against ${bars.plans.bar}: ${bars.plans.right < bars.plans.bar ? 'below' : bars.plans.right === bars.plans.bar ? 'at' : 'above'}`);
  if (bars.plans.right < bars.plans.bar) findings.push({ bar: 'plans', figure: `${bars.plans.right} of ${bars.plans.of}`, kind: 'plans below the bar', where: 'set router' });
  lines.push(`refusals: ${bars.refusals.refused} of ${bars.refusals.of} against ${bars.refusals.of}: ${bars.refusals.refused < bars.refusals.of ? 'below' : 'at'}`);
  if (bars.refusals.refused < bars.refusals.of) findings.push({ bar: 'refusals', figure: `${bars.refusals.refused} of ${bars.refusals.of}`, kind: 'refusals below the bar', where: 'set router' });
  for (const regression of bars.regressions) {
    if (regression.baseline === null) {
      lines.push(`regression ${regression.set}: no baseline exists: the regression is not checked`);
      continue;
    }
    if (regression.baselineModel === null || regression.baselineCommit === null || regression.baselineRun === null) {
      lines.push(`regression ${regression.set}: the baseline names no model, commit or run: not checked`);
      findings.push({ bar: `regression ${regression.set}`, figure: String(regression.now), kind: 'baseline provenance missing', where: `set ${regression.set}` });
      continue;
    }
    lines.push(`regression ${regression.set}: ${regression.now} against baseline ${regression.baseline} (${regression.baselineModel}, ${regression.baselineCommit}, ${regression.baselineRun}): ${regression.now < regression.baseline ? 'below' : 'at or above'}`);
    if (regression.now < regression.baseline) findings.push({ bar: `regression ${regression.set}`, figure: String(regression.now), kind: 'below the baseline', where: `set ${regression.set}` });
  }
  lines.push(findings.length === 0 ? 'status: every figure is at or above its bar' : 'status: open (a figure is below its bar or missing)');
  return { lines, findings, status: findings.length === 0 ? 'met' : 'open' };
}

/** The decision on the text arm, from the counted repeats only: adopted only when its median is at or above the references arm and its C4 is not lower, and the two have the same repeats counted; otherwise references stay. */
export function textDecision(arms: readonly ArmFigures[], refs: string, text: string | undefined): string {
  if (text === undefined) return 'text arm not run: references stay';
  const a = arms.find((entry) => entry.arm === refs);
  const b = arms.find((entry) => entry.arm === text);
  if (b === undefined || a === undefined) return 'text arm not run: references stay';
  const countedA = a.repeats.filter((entry) => entry.counted).map((entry) => entry.repeat).join(',');
  const countedB = b.repeats.filter((entry) => entry.counted).map((entry) => entry.repeat).join(',');
  if (a.countedMedian === undefined || b.countedMedian === undefined || countedA === '' || countedA !== countedB) return 'text arm not decided: the counted repeats of the two arms are missing or differ, adoption is withheld and references stay';
  return b.countedMedian >= a.countedMedian && b.countedCriteria.c4 >= a.countedCriteria.c4 ? 'text is adopted: its median is at or above references and its C4 is not lower' : 'references stay: text is below references or its C4 is lower';
}
