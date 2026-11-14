import type { AskRunResult, AskSummary, ElementRef } from '@neburyx/contracts';
import { citedKeysExist, type ListedElements } from './core.js';
import { degreeListed, summarizeDegree } from './degree.js';
import { derivedEdgeListed, derivedRuleListed, summarizeDerivedEdge, summarizeDerivedRule } from './derived.js';
import { entityListed, summarizeEntity } from './entity.js';
import { expandListed, summarizeExpand } from './expand.js';
import { savedPatternListed, summarizeSavedPattern } from './saved-pattern.js';
import { searchListed, summarizeSearch } from './search.js';
import { summarizeTemplateRun, templateRunListed } from './template-run.js';

export { citedKeysExist } from './core.js';
export type { ListedElements } from './core.js';
import { fileQueryListed, summarizeFileQuery } from './file-query.js';

export interface SummaryContext {
  /** The anchor of the run, when it has one: a run of a template names it in its zero-match sentence. */
  readonly anchor?: ElementRef | undefined;
}

/** The elements a result lists, which a citation may name. A result that stopped as heavy lists nothing. */
export function listedElements(run: AskRunResult): ListedElements | undefined {
  switch (run.templateId) {
    case 'shared-attribute':
    case 'linked-entities':
      return run.result.status === 'ok' ? templateRunListed(run.result) : undefined;
    case 'entity':
      return entityListed(run.result);
    case 'degree-preview':
      return degreeListed(run.result);
    case 'expand':
      return expandListed(run.result);
    case 'derived-rule-run':
      return derivedRuleListed(run.result);
    case 'derived-edge-support':
      return derivedEdgeListed(run.result);
    case 'search':
      return searchListed(run.result);
    case 'saved-pattern':
      return savedPatternListed(run.result);
    case 'file-query':
      return fileQueryListed(run.result);
    default: {
      const unreachable: never = run;
      return unreachable;
    }
  }
}

function build(run: AskRunResult, context: SummaryContext): AskSummary | undefined {
  switch (run.templateId) {
    case 'shared-attribute':
    case 'linked-entities':
      return run.result.status === 'ok' ? summarizeTemplateRun(run.result, context.anchor) : undefined;
    case 'entity':
      return summarizeEntity(run.result);
    case 'degree-preview':
      return summarizeDegree(run.result);
    case 'expand':
      return summarizeExpand(run.result);
    case 'derived-rule-run':
      return summarizeDerivedRule(run.result);
    case 'derived-edge-support':
      return summarizeDerivedEdge(run.result);
    case 'search':
      return summarizeSearch(run.result);
    case 'saved-pattern':
      return summarizeSavedPattern(run.result, context.anchor);
    case 'file-query':
      return summarizeFileQuery(run.result);
    default: {
      const unreachable: never = run;
      return unreachable;
    }
  }
}

export type SummaryOutcome = { readonly kind: 'none' } | { readonly kind: 'summary'; readonly summary: AskSummary } | { readonly kind: 'check-failed' };

/**
 * The summary of a run result: sentences built from the result alone by fixed rules (no model, no read, no clock), each citing elements the result lists. A summary that fails its own check is reported as such, never
 * returned: the answer then carries no summary, and the caller says why.
 */
export function summarize(run: AskRunResult, context: SummaryContext = {}): SummaryOutcome {
  const listed = listedElements(run);
  if (listed === undefined) return { kind: 'none' };
  const summary = build(run, context);
  if (summary === undefined) return { kind: 'none' };
  return citedKeysExist(summary, listed) ? { kind: 'summary', summary } : { kind: 'check-failed' };
}

export function buildSummary(run: AskRunResult, context: SummaryContext = {}): AskSummary | undefined {
  const outcome = summarize(run, context);
  return outcome.kind === 'summary' ? outcome.summary : undefined;
}
