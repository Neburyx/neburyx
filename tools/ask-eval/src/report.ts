import { allowedMisses, type Scored } from './score.js';

export interface Result {
  readonly refusals: { readonly total: number; readonly refused: number };
  readonly plans: { readonly total: number; readonly right: number; readonly allowedMisses: number };
  readonly unsupported: number;
  readonly misses: readonly { readonly name: string; readonly cause: string }[];
  readonly scripted: boolean;
  readonly targetsMet: boolean;
}

export function resultOf(scored: readonly Scored[], scripted: boolean): Result {
  const refusals = scored.filter((entry) => entry.expect === 'refuse');
  const plans = scored.filter((entry) => entry.expect === 'plan');
  const refused = refusals.filter((entry) => entry.miss === undefined).length;
  const right = plans.filter((entry) => entry.miss === undefined).length;
  const allowed = allowedMisses(plans.length);
  return {
    refusals: { total: refusals.length, refused },
    plans: { total: plans.length, right, allowedMisses: allowed },
    unsupported: plans.filter((entry) => entry.unsupported).length,
    misses: scored.flatMap((entry) => (entry.miss === undefined ? [] : [{ name: entry.name, cause: entry.miss }])),
    scripted,
    targetsMet: refused === refusals.length && plans.length - right <= allowed,
  };
}

const percent = (part: number, whole: number): string => (whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(1)}%`);

/** The lines of a report: counts, ids and causes only; no wording, no entity value and no reply is ever printed. */
export function reportLines(result: Result, label: string, model: string | undefined): string[] {
  const lines = [`set: ${label}`];
  if (result.scripted) lines.push('replay: scripted from the expectations, not a model');
  else lines.push(`model: ${model ?? 'unknown'}`);
  lines.push(`refusals: ${result.refusals.refused} of ${result.refusals.total} refused`);
  lines.push(`plans: ${result.plans.right} of ${result.plans.total} right (${percent(result.plans.right, result.plans.total)}), at most ${result.plans.allowedMisses} may miss`);
  lines.push(`plan questions answered no-intent: ${result.unsupported} of ${result.plans.total}`);
  for (const miss of result.misses) lines.push(`miss: ${miss.name} ${miss.cause}`);
  return lines;
}
