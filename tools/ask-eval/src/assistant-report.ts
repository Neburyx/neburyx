import type { AssistantScored, FirstReply } from './assistant-score.js';
import { resultOf, type Result } from './report.js';

/** How the first replies of the router were, counted from the requests whose first reply is recorded: and the repeat that followed a reply that was not a route. */
interface FirstReplies {
  readonly counted: number;
  readonly bare: number;
  readonly textAround: number;
  readonly wrongForm: number;
  readonly didNotFit: number;
  readonly failed: number;
  readonly noFirstReply: number;
  readonly rescued: number;
  readonly unplaced: number;
  /** The share of the first replies that were a route or not a bare one (`counted` excludes the failed calls and the requests with no first reply). */
  readonly notBare: number;
  readonly rate: number;
  readonly ids: readonly { readonly name: string; readonly kind: FirstReply }[];
}

function firstRepliesOf(scored: readonly AssistantScored[]): FirstReplies {
  const count = (kind: FirstReply): number => scored.filter((entry) => entry.first === kind).length;
  const counted = scored.filter((entry) => entry.first !== undefined && entry.first !== 'failed').length;
  const notBare = count('text-around') + count('wrong-form') + count('did-not-fit');
  return {
    counted,
    bare: count('bare'),
    textAround: count('text-around'),
    wrongForm: count('wrong-form'),
    didNotFit: count('did-not-fit'),
    failed: count('failed'),
    noFirstReply: scored.filter((entry) => entry.first === undefined).length,
    rescued: scored.filter((entry) => entry.first !== undefined && entry.first !== 'bare' && entry.first !== 'failed' && entry.unplaced !== true && entry.calls === 2 && entry.miss !== 'unplaced').length,
    unplaced: scored.filter((entry) => entry.unplaced === true).length,
    notBare,
    rate: counted === 0 ? 0 : notBare / counted,
    ids: scored.flatMap((entry) => (entry.first === undefined || entry.first === 'bare' ? [] : [{ name: entry.name, kind: entry.first }])),
  };
}

export interface AssistantResult extends Result {
  readonly firstReplies: FirstReplies;
  /** For each refusal cause the set expects: how many messages expect it and how many were refused with it. */
  readonly causes: readonly { readonly cause: string; readonly total: number; readonly refused: number }[];
  readonly messages: number;
}

export function assistantResultOf(scored: readonly AssistantScored[], scripted: boolean): AssistantResult {
  const base = resultOf(scored, scripted);
  const causes = [...new Set(scored.flatMap((entry) => (entry.refusalCause === undefined ? [] : [entry.refusalCause])))].sort();
  return {
    ...base,
    messages: scored.length,
    firstReplies: firstRepliesOf(scored),
    causes: causes.map((cause) => {
      const entries = scored.filter((entry) => entry.refusalCause === cause);
      return { cause, total: entries.length, refused: entries.filter((entry) => entry.miss === undefined).length };
    }),
  };
}

const percent = (part: number, whole: number): string => (whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(1)}%`);

/** The lines of a report: counts, ids and causes only; no wording, no entity value and no reply is ever printed. */
export function assistantReportLines(result: AssistantResult, label: string, model: string | undefined): string[] {
  const lines = [`set: ${label}`];
  if (result.scripted) lines.push('replay: scripted from the expectations, not a model');
  else lines.push(`model: ${model ?? 'unknown'}`);
  lines.push(`refusals: ${result.refusals.refused} of ${result.refusals.total} refused with their expected cause`);
  for (const cause of result.causes) lines.push(`refusal cause ${cause.cause}: ${cause.refused} of ${cause.total}`);
  lines.push(`plans: ${result.plans.right} of ${result.plans.total} right (${percent(result.plans.right, result.plans.total)}), at most ${result.plans.allowedMisses} may miss`);
  const first = result.firstReplies;
  lines.push(`first replies counted: ${first.counted}; bare route: ${first.bare}; text around the route: ${first.textAround}; no route in it: ${first.wrongForm}; a route the turn did not accept: ${first.didNotFit}`);
  lines.push(`first replies failed: ${first.failed}; requests with no first reply: ${first.noFirstReply}; rescued by the repeat: ${first.rescued}; ended unplaced: ${first.unplaced}`);
  lines.push(`first replies that were not a bare route: ${first.notBare} of ${first.counted} (${percent(first.notBare, first.counted)})`);
  for (const entry of first.ids) lines.push(`first reply: ${entry.name} ${entry.kind}`);
  for (const miss of result.misses) lines.push(`miss: ${miss.name} ${miss.cause}`);
  return lines;
}
