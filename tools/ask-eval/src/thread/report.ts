import type { KeyEntry } from './blind.js';
import type { Score, ScoreFile } from './scorer.js';

export interface ArmFigures {
  readonly arm: string;
  /** Per repeat: the sum of C1 to C4 over the turns, the scorer, and whether the repeat counts toward the bar. */
  readonly repeats: readonly { readonly repeat: number; readonly total: number; readonly scorer: string; readonly counted: boolean; readonly indicative: boolean }[];
  readonly median: number | undefined;
  readonly countedMedian: number | undefined;
  readonly criteria: Readonly<Record<'c1' | 'c2' | 'c3' | 'c4', number>>;
  readonly turns: number;
}

export interface KeyFile {
  readonly entries: readonly KeyEntry[];
}

const medianOf = (values: readonly number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/**
 * The scores unblinded with the key: per arm and per repeat the sum of C1 to C4 over the turns, the median over repeats and the counts per criterion. `primary` is the scorer the bar is judged on; a repeat scored by
 * another scorer is reported, marked indicative when `indicativeScorers` names it, and never counted toward the verdict of the bar.
 */
export function unblind(files: readonly ScoreFile[], key: KeyFile, options: { readonly primary: string; readonly indicativeScorers: readonly string[] }): ArmFigures[] {
  const byLabel = new Map<string, string>();
  for (const entry of key.entries) for (const [label, arm] of Object.entries(entry.labels)) byLabel.set(`${entry.repeat}/${entry.turn}/${label}`, arm);
  const arms = [...new Set(byLabel.values())].sort();
  const result: ArmFigures[] = [];
  for (const arm of arms) {
    const totals = new Map<number, { total: number; scorer: string }>();
    const criteria = { c1: 0, c2: 0, c3: 0, c4: 0 };
    let turns = 0;
    for (const file of files) {
      for (const score of file.scores as readonly Score[]) {
        if (byLabel.get(`${score.repeat}/${score.turn}/${score.label}`) !== arm) continue;
        const held = totals.get(score.repeat) ?? { total: 0, scorer: file.scorer };
        held.total += score.c1 + score.c2 + score.c3 + score.c4;
        totals.set(score.repeat, held);
        criteria.c1 += score.c1;
        criteria.c2 += score.c2;
        criteria.c3 += score.c3;
        criteria.c4 += score.c4;
        turns += 1;
      }
    }
    const repeats = [...totals.entries()].sort((a, b) => a[0] - b[0]).map(([repeat, held]) => ({ repeat, total: held.total, scorer: held.scorer, counted: held.scorer === options.primary, indicative: options.indicativeScorers.includes(held.scorer) }));
    result.push({ arm, repeats, median: medianOf(repeats.map((entry) => entry.total)), countedMedian: medianOf(repeats.filter((entry) => entry.counted).map((entry) => entry.total)), criteria, turns });
  }
  return result;
}

export interface Bars {
  /** The trial's median of the comparison arm (an external private input). */
  readonly threadMedian: number;
  readonly plans: { readonly right: number; readonly of: number; readonly bar: number };
  readonly refusals: { readonly refused: number; readonly of: number };
  /** The regression sets against their Sonnet baselines: the figure now and the baseline, higher is better. */
  readonly regressions: readonly { readonly set: string; readonly now: number; readonly baseline: number }[];
}

interface Finding {
  readonly bar: string;
  readonly figure: string;
  readonly kind: string;
  /** Where the miss is: criterion, turn or set; ids and counts only. */
  readonly where: string;
}

export interface BarReport {
  readonly lines: readonly string[];
  readonly findings: readonly Finding[];
  /** `open` as long as any figure is below its bar or evidence is missing; the feature is never reported done from here. */
  readonly status: 'open' | 'met';
}

/** The bars checked: each figure against its bar, below / at or above; a figure below a bar is an open finding with its kind and place, never a wording. */
export function checkBars(arms: readonly ArmFigures[], product: string, bars: Bars): BarReport {
  const lines: string[] = [];
  const findings: Finding[] = [];
  const figure = arms.find((entry) => entry.arm === product);
  const median = figure?.countedMedian;
  if (median === undefined) {
    lines.push('thread rubric: no repeat scored by the primary scorer');
    findings.push({ bar: 'thread rubric', figure: 'none', kind: 'no figure', where: 'all repeats' });
  } else {
    const verdict = median < bars.threadMedian ? 'below' : median === bars.threadMedian ? 'at' : 'above';
    lines.push(`thread rubric: median ${median} of ${(figure?.turns ?? 0) / Math.max(1, figure?.repeats.length ?? 1) * 4} against ${bars.threadMedian}: ${verdict}`);
    if (verdict === 'below') {
      const weakest = (Object.entries(figure?.criteria ?? {}) as ['c1' | 'c2' | 'c3' | 'c4', number][]).sort((a, b) => a[1] - b[1])[0];
      findings.push({ bar: 'thread rubric', figure: String(median), kind: 'below the trial median', where: weakest === undefined ? 'criteria' : `criterion ${weakest[0].toUpperCase()}` });
    }
  }
  lines.push(`plans: ${bars.plans.right} of ${bars.plans.of} against ${bars.plans.bar}: ${bars.plans.right < bars.plans.bar ? 'below' : bars.plans.right === bars.plans.bar ? 'at' : 'above'}`);
  if (bars.plans.right < bars.plans.bar) findings.push({ bar: 'plans', figure: `${bars.plans.right} of ${bars.plans.of}`, kind: 'plans below the bar', where: 'router set' });
  lines.push(`refusals: ${bars.refusals.refused} of ${bars.refusals.of} against ${bars.refusals.of}: ${bars.refusals.refused < bars.refusals.of ? 'below' : 'at'}`);
  if (bars.refusals.refused < bars.refusals.of) findings.push({ bar: 'refusals', figure: `${bars.refusals.refused} of ${bars.refusals.of}`, kind: 'refusals below the bar', where: 'router set' });
  for (const regression of bars.regressions) {
    lines.push(`regression ${regression.set}: ${regression.now} against baseline ${regression.baseline}: ${regression.now < regression.baseline ? 'below' : 'at or above'}`);
    if (regression.now < regression.baseline) findings.push({ bar: `regression ${regression.set}`, figure: String(regression.now), kind: 'below the baseline', where: regression.set });
  }
  lines.push(findings.length === 0 ? 'status: every figure is at or above its bar' : 'status: open (a figure is below its bar or missing)');
  return { lines, findings, status: findings.length === 0 ? 'met' : 'open' };
}

/** The decision on the text arm: adopted only when its median is at or above the references arm and its C4 is not lower; otherwise references stay; with no text arm it says so. */
export function textDecision(arms: readonly ArmFigures[], refs: string, text: string): string {
  const a = arms.find((entry) => entry.arm === refs);
  const b = arms.find((entry) => entry.arm === text);
  if (b === undefined || a === undefined) return 'text arm not run: references stay';
  const medianB = b.countedMedian ?? b.median;
  const medianA = a.countedMedian ?? a.median;
  if (medianA === undefined || medianB === undefined) return 'text arm not scored: references stay';
  return medianB >= medianA && b.criteria.c4 >= a.criteria.c4 ? 'text is adopted: its median is at or above references and its C4 is not lower' : 'references stay: text is below references or its C4 is lower';
}
