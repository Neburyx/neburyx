import { askSummarySchema, type AskRunResult, type AskSummary, type ElementRef, type ExtensionLogger } from '@neburyx/contracts';
import { summarize } from './index.js';

/** The event of the warning logged when a summary is dropped. It carries a fixed code and nothing of the result. */
export const SUMMARY_DROPPED_EVENT = 'ask-summary-dropped';
export type SummaryDropCode = 'builder-threw' | 'other-source' | 'check-failed' | 'schema';

/** The anchor a plan's own parameters name, when they name one: the plan's source, the entity type and the stable ID. */
export function anchorOfParams(sourceId: string, params: unknown): ElementRef | undefined {
  if (typeof params !== 'object' || params === null || !('ref' in params)) return undefined;
  const { ref } = params;
  if (typeof ref !== 'object' || ref === null || !('entityType' in ref) || !('stableId' in ref)) return undefined;
  return typeof ref.entityType === 'string' && typeof ref.stableId === 'string' && ref.entityType !== '' && ref.stableId !== '' ? { sourceId, entityType: ref.entityType, stableId: ref.stableId } : undefined;
}

/**
 * The summary the run answer carries, or nothing. It is built after the run is recorded and audited, from the result alone, so it never changes the outcome. A summary whose citations are not of the plan's source,
 * or a builder that throws, is dropped whole and a warning with a fixed code is logged (no value of the result).
 */
export function summaryOfRun(run: AskRunResult, plan: { readonly sourceId: string; readonly params: unknown }, logger: ExtensionLogger | undefined): AskSummary | undefined {
  const drop = (code: SummaryDropCode): undefined => {
    try {
      logger?.warn({ event: SUMMARY_DROPPED_EVENT, code }, 'a summary was left out of a run answer');
    } catch {
      // a logger that fails changes nothing
    }
    return undefined;
  };
  try {
    const outcome = summarize(run, { anchor: anchorOfParams(plan.sourceId, plan.params) });
    if (outcome.kind === 'none') return undefined;
    if (outcome.kind === 'check-failed') return drop('check-failed');
    const { summary } = outcome;
    if (!summary.citations.every((citation) => citation.element.sourceId === plan.sourceId)) return drop('other-source');
    // the answer is parsed by the route's own schema: a summary that does not fit it must not turn a recorded run into an error
    return askSummarySchema.safeParse(summary).success ? summary : drop('schema');
  } catch {
    return drop('builder-threw');
  }
}
