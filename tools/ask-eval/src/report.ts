import { belowBaseline, type BaselineMode, type BaselineValue } from './baseline.js';
import type { RunSummary } from './groups.js';
import type { QuestionResult } from './run.js';
import { meetsTargets, type Tally } from './targets.js';

const GOOD = new Set(['right', 'refused', 'blocked']);

export interface Summary {
  readonly lines: readonly string[];
  readonly met: boolean;
  readonly data: RunSummary;
}

export function summarize(found: Tally, results: readonly QuestionResult[], maxPlanMisses: number, mode: BaselineMode, baseline: BaselineValue | undefined): Summary {
  const outcome = meetsTargets(found, maxPlanMisses);
  const below = belowBaseline(found, baseline);
  const lines = [
    `refusals: ${found.refusals.refused} of ${found.refusals.total} refused`,
    `plans: ${found.plans.right} of ${found.plans.total} right (at most ${maxPlanMisses} may miss)`,
    found.family.measured ? `family: ${found.family.right} of ${found.family.asked} as expected` : 'family: not measured',
    `blocked: ${found.blocked.blocked} of ${found.blocked.total} expected`,
    `repaired: ${found.repaired}`,
  ];
  const byRule = results.filter((entry) => entry.rule === 'one-hop-neighbors').length;
  if (byRule > 0) lines.push(`scored right by the one-hop rule: ${byRule}`);
  const blockedRefusals = results.filter((entry) => entry.rule === 'blocked-before-planning').length;
  if (blockedRefusals > 0) lines.push(`scored refused because the allowlist blocked the question: ${blockedRefusals}`);
  for (const result of results.filter((entry) => !GOOD.has(entry.verdict))) lines.push(result.fields.length === 0 ? `${result.verdict}: ${result.id}` : `${result.verdict}: ${result.id} (${result.fields.join(', ')})`);
  if (!outcome.refusalsMet) lines.push('target missed: every refusal must be refused');
  if (!outcome.plansMet) lines.push(`target missed: more than ${maxPlanMisses} plans missed`);
  if (!outcome.blockedMet) lines.push('target missed: every blocked question must be blocked');
  if (baseline === undefined) lines.push(`no baseline for the mode ${mode}: only the targets apply`);
  if (below) lines.push(`baseline missed: the mode ${mode} had ${baseline?.plansRight ?? 0} plans and ${baseline?.refusalsRefused ?? 0} refusals right`);
  const data: RunSummary = {
    refusals: { total: found.refusals.total, refused: found.refusals.refused },
    plans: { total: found.plans.total, right: found.plans.right, maxMisses: maxPlanMisses },
    blocked: { total: found.blocked.total, blocked: found.blocked.blocked },
    family: { measured: found.family.measured, asked: found.family.asked, right: found.family.right },
    repaired: found.repaired,
    targets: { refusalsMet: outcome.refusalsMet, plansMet: outcome.plansMet, blockedMet: outcome.blockedMet },
    baseline: { mode, value: baseline ?? null, missed: below },
  };
  return { lines, met: outcome.refusalsMet && outcome.plansMet && outcome.blockedMet && !below, data };
}
