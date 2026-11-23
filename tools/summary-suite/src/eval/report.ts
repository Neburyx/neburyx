import type { BudgetUsage, ProviderLabel } from './hooks.js';
import type { Measurement, Proposal } from './measure.js';

type ViewStatus = 'ok' | 'partial' | 'unsupported' | 'tooLarge' | 'failed' | 'timeLimit' | 'cancelled' | 'not run';

export interface ViewReport {
  readonly id: string;
  readonly kind: 'demo' | 'aml';
  readonly status: ViewStatus;
  /** The kind of failure when the click failed. */
  readonly failureKind?: string;
  readonly calls: number;
  readonly factsFound: readonly string[];
  readonly factsMissed: readonly string[];
  readonly claimsMade: readonly string[];
  /** Of the last checked reply: the sentences the model wrote, the ones kept and the ones removed. */
  readonly sentencesWritten: number;
  readonly sentencesKept: number;
  readonly sentencesRemoved: number;
  /** Whether the checks judged a reply at all; when not, every figure of the last checked reply is 0 and says nothing. */
  readonly checked: boolean;
  /** Summed over every reply the checks judged. */
  readonly keysStripped: number;
  readonly keysRemoved: number;
  /** The invented names of the labelled set that a kept sentence holds (synthetic names). */
  readonly namesKept: readonly string[];
  /** Removed sentences of the last checked reply whose verdict wording lies only inside the title of an element. */
  readonly verdictInTitle: number;
  /** Removed sentences of the last checked reply that no cause the command knows explains, by the id of the fact they state: for a person to read. */
  readonly forReview: readonly string[];
  /** Labelled `keep` sentences of the last checked reply that were not kept, and labelled `remove` sentences of it that were kept. */
  readonly wronglyRemoved: readonly string[];
  readonly slipped: readonly string[];
  readonly tokens: { readonly known: boolean; readonly input: number; readonly output: number };
  readonly milliseconds: number;
}

export interface Report {
  readonly mode: 'stub' | 'live';
  readonly model: string;
  readonly instructionsSha256: string;
  /** The hash of the instructions of each pack's views when the typology differs between them; absent when one text served every view. */
  readonly instructionsByPack?: Readonly<Record<string, string>>;
  readonly budget: number;
  readonly usage: BudgetUsage;
  /** Present for a local run only: the provider kind, the grammar label and the schema probe. */
  readonly provider?: ProviderLabel;
  readonly budgetSpent: boolean;
  readonly views: readonly ViewReport[];
  /** The measurements of a measuring run, and what they support: sizes and counts only. */
  readonly measurements?: readonly Measurement[];
  readonly proposal?: Proposal;
}

const sum = (views: readonly ViewReport[], pick: (view: ViewReport) => number): number => views.reduce((total, view) => total + pick(view), 0);

export interface Totals {
  readonly viewsRun: number;
  readonly viewsNotRun: number;
  readonly factsFound: number;
  readonly factsExpected: number;
  readonly claimsMade: number;
  readonly sentencesWritten: number;
  readonly sentencesKept: number;
  readonly sentencesRemoved: number;
  readonly keysStripped: number;
  readonly keysRemoved: number;
  readonly namesKept: number;
  readonly verdictInTitle: number;
  readonly forReview: number;
  readonly wronglyRemoved: number;
  readonly slipped: number;
  readonly milliseconds: number;
}

function totalsOf(views: readonly ViewReport[]): Totals {
  const ran = views.filter((view) => view.status !== 'not run');
  return {
    viewsRun: ran.length,
    viewsNotRun: views.length - ran.length,
    factsFound: sum(ran, (view) => view.factsFound.length),
    factsExpected: sum(ran, (view) => view.factsFound.length + view.factsMissed.length),
    claimsMade: sum(ran, (view) => view.claimsMade.length),
    sentencesWritten: sum(ran, (view) => view.sentencesWritten),
    sentencesKept: sum(ran, (view) => view.sentencesKept),
    sentencesRemoved: sum(ran, (view) => view.sentencesRemoved),
    keysStripped: sum(ran, (view) => view.keysStripped),
    keysRemoved: sum(ran, (view) => view.keysRemoved),
    namesKept: sum(ran, (view) => view.namesKept.length),
    verdictInTitle: sum(ran, (view) => view.verdictInTitle),
    forReview: sum(ran, (view) => view.forReview.length),
    wronglyRemoved: sum(ran, (view) => view.wronglyRemoved.length),
    slipped: sum(ran, (view) => view.slipped.length),
    milliseconds: sum(ran, (view) => view.milliseconds),
  };
}

/** The report as plain lines: ids, counts and causes only; never a sentence of the model or an entity value (the printed report names the synthetic invented names of the labelled set that a kept sentence held; the record file does not). */
export function textOf(report: Report): string[] {
  const totals = totalsOf(report.views);
  const lines = [
    `mode: ${report.mode}`,
    `model: ${report.model}`,
    `instructions hash: ${report.instructionsSha256}`,
    ...(report.instructionsByPack === undefined ? [] : Object.entries(report.instructionsByPack).map(([pack, hash]) => `instructions hash of the views of ${pack}: ${hash}`)),
    `calls: ${report.usage.calls} of ${report.budget}${report.budgetSpent ? ' (the budget was spent)' : ''}`,
    `tokens: in ${report.usage.inputTokens}, out ${report.usage.outputTokens}, cache read ${report.usage.cacheReadTokens}, cache write ${report.usage.cacheWriteTokens}, calls without counts ${report.usage.withoutCounts}`,
    `failed calls: ${report.usage.failed}`,
    `time of a call: median ${report.usage.medianMs} ms, 95th percentile ${report.usage.p95Ms} ms`,
    '',
  ];
  if (report.provider?.kind === 'local') lines.splice(2, 0, `provider: local, grammar ${report.provider.grammar === true ? 'on' : 'off'}`, ...(report.provider.thinking === 'off' ? ['thinking: off'] : []), ...(report.provider.grammarPrompts !== undefined && report.provider.grammarPrompts.length > 0 ? [`grammar prompts: ${report.provider.grammarPrompts.join(', ')}`] : []), ...(report.provider.probe === undefined ? [] : [`schema probe: ${report.provider.probe}`]));
  for (const view of report.views) {
    if (view.status === 'not run') {
      lines.push(`${view.id} [${view.kind}]: not run`);
      continue;
    }
    const parts = [
      `calls ${view.calls}`,
      `facts ${view.factsFound.length}/${view.factsFound.length + view.factsMissed.length}${view.factsMissed.length > 0 ? ` (missed ${view.factsMissed.join(', ')})` : ''}`,
      `claims made ${view.claimsMade.length}${view.claimsMade.length > 0 ? ` (${view.claimsMade.join(', ')})` : ''}`,
      view.checked ? `last reply: wrote ${view.sentencesWritten}, kept ${view.sentencesKept}, removed ${view.sentencesRemoved}` : 'no reply was checked',
      `keys stripped ${view.keysStripped}, removed ${view.keysRemoved}`,
      ...(view.namesKept.length > 0 ? [`names kept: ${view.namesKept.join(', ')}`] : []),
      ...(view.verdictInTitle > 0 ? [`verdict word only in a title: ${view.verdictInTitle}`] : []),
      ...(view.forReview.length > 0 ? [`removed for a person to read (facts ${view.forReview.join(', ')})`] : []),
      ...(view.wronglyRemoved.length > 0 ? [`labelled good sentences removed: ${view.wronglyRemoved.join(', ')}`] : []),
      ...(view.slipped.length > 0 ? [`labelled sentences that slipped: ${view.slipped.join(', ')}`] : []),
      `tokens ${view.tokens.known ? `in ${view.tokens.input}, out ${view.tokens.output}` : 'unknown'}`,
      `${view.milliseconds} ms`,
    ];
    lines.push(`${view.id} [${view.kind}]: ${view.status}${view.failureKind === undefined ? '' : ` (${view.failureKind})`} | ${parts.join(' | ')}`);
  }
  lines.push(
    '',
    `totals: views run ${totals.viewsRun}, not run ${totals.viewsNotRun}; facts ${totals.factsFound}/${totals.factsExpected}; claims made ${totals.claimsMade}`,
    `sentences (last checked reply of each view): written ${totals.sentencesWritten}, kept ${totals.sentencesKept}, removed ${totals.sentencesRemoved}`,
    `keys stripped ${totals.keysStripped}, keys removed ${totals.keysRemoved} (every reply the checks judged)`,
    `names kept ${totals.namesKept}; verdict word only in a title ${totals.verdictInTitle}; removed for a person to read ${totals.forReview}; labelled good sentences removed ${totals.wronglyRemoved}; labelled sentences that slipped ${totals.slipped}`,
    `time ${totals.milliseconds} ms`,
  );
  if (report.measurements !== undefined) {
    lines.push('', 'measurements (UTF-8 bytes of the instructions plus the values; tokens as the provider counted them):');
    for (const each of report.measurements) {
      lines.push(
        each.measured
          ? `${each.id} [${each.kind}]: ${each.elements} elements | ${each.bytes} bytes | estimate ${each.estimatedTokens} tokens | measured ${each.inputTokens} tokens | ${each.bytesPerToken?.toFixed(2)} bytes a token | ${each.tokensPerElement?.toFixed(1)} tokens an element`
          : `${each.id} [${each.kind}]: ${each.elements} elements | ${each.bytes === undefined ? 'no bytes' : `${each.bytes} bytes | estimate ${each.estimatedTokens} tokens`} | not measured (${each.missing ?? 'unknown'})`,
      );
    }
    const proposal = report.proposal;
    if (proposal?.proposed === true) lines.push(`proposal: ${proposal.bytesPerToken} bytes a token (replaces the product's estimate), size guard ${proposal.maxInputTokens} tokens${proposal.upperBoundMaxInputTokens === undefined ? '' : ` (upper bound with heavy properties: ${proposal.upperBoundMaxInputTokens} tokens)`}`);
    else if (report.mode === 'stub') lines.push('not measured: a scripted provider states no token counts; nothing is proposed');
    else lines.push(`no proposal: ${(proposal?.missing ?? ['not measured']).join('; ')}`);
  }
  return lines;
}

export const jsonOf = (report: Report): string => JSON.stringify({ ...report, totals: totalsOf(report.views) }, null, 2);

/** The figures of a run as the record file keeps them: the invented names a kept sentence held are a count there, never the names. */
export const recordOf = (report: Report): string => JSON.stringify({ ...report, views: report.views.map((view) => ({ ...view, namesKept: view.namesKept.length })), totals: totalsOf(report.views) }, null, 2);
