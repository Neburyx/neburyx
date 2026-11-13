import { patternDefinitionSchema, type Count, type PatternRunResponse } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import { allowlistFromMapping } from '../gate/allowlist.js';
import { isNormalizedPattern } from '../gate/normalize/pattern.js';
import { patternTemplate } from '../gate/templates/pattern.js';
import { patternNoticesOf, patternCountQualityOf } from '../gate/templates/pattern-notices.js';
import { patternRequestOf } from '../gate/templates/pattern-request.js';
import type { Gate, GateRequest } from '../gate/types.js';
import { continueLimitOf, gateRun, probeEstimateOf } from '../graph/template-run-service.js';
import { defaultTemplateProbes, type TemplateProbe } from '../graph/template-probes.js';
import { windowInstantsOf } from '../graph/template-window.js';
import type { SourceAccess } from '../investigations/source-access.js';
import type { MappingModel } from '../mapping/model.js';
import type { Principal } from '../seams/seams.js';
import { validatePattern } from './validate.js';

export const PATTERN_SCOPE = 'template:pattern';

export interface PatternRunCall {
  readonly traceId: string;
  readonly principal: Principal;
  readonly sourceId: string;
  readonly definition: unknown;
  readonly anchor: { readonly entityType: string; readonly stableId: string };
  readonly limit?: number | undefined;
  readonly mask: boolean;
  /** Continue a run that stopped as heavy: no estimate is read and the page is at most the continue size. */
  readonly continue?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface PatternRunService {
  run(call: PatternRunCall): Promise<PatternRunResponse>;
}

/**
 * Runs a definition for an anchor through the gate. The order is fixed and nothing is read before it is settled: the access to the source; the anchor's type against the definition's; the definition against the source's
 * mapping (a problem is `INVALID_REQUEST`, and the one problem of more steps than the source allows is `QUERY_BUDGET_EXCEEDED` with the cap); then the estimate, when the pattern template has a probe and the run is not a continue; then
 * the run, one gate call of the `pattern` template. The answer's count is labelled by what the read did, and its notices are the ones the preview and the compiler follow.
 */
export function createPatternRunService(deps: { readonly gate: Gate; readonly mapping: MappingModel; readonly access: SourceAccess; readonly now?: () => Date; readonly probes?: ReadonlyMap<string, TemplateProbe> }): PatternRunService {
  const allowlists = new Map(deps.mapping.sources.map((source) => [source.id, allowlistFromMapping(source)]));
  const now = deps.now ?? (() => new Date());
  const probes = deps.probes ?? defaultTemplateProbes();
  return {
    async run(call) {
      await deps.access.require({ traceId: call.traceId, principal: call.principal, sourceId: call.sourceId, auditAction: patternTemplate.auditAction, rate: 'count' });
      const source = deps.mapping.sources.find((candidate) => candidate.id === call.sourceId);
      const allowlist = allowlists.get(call.sourceId);
      if (source === undefined || allowlist === undefined) throw new AppError('NOT_FOUND');
      const claimed = typeof call.definition === 'object' && call.definition !== null && 'anchorType' in call.definition ? call.definition.anchorType : undefined;
      if (typeof claimed === 'string' && claimed !== call.anchor.entityType) throw new AppError('INVALID_REQUEST');
      const problems = validatePattern(call.definition, source, { mask: call.mask });
      if (problems.length > 0) {
        if (problems.every((problem) => problem.code === 'too-many-hops')) throw new AppError('QUERY_BUDGET_EXCEEDED', { maxHops: source.budgets.maxHops });
        throw new AppError('INVALID_REQUEST');
      }
      const definition = patternDefinitionSchema.parse(call.definition);
      if (definition.anchorType !== call.anchor.entityType) throw new AppError('INVALID_REQUEST');
      const at = now();
      const params = {
        anchorType: definition.anchorType,
        stableId: call.anchor.stableId,
        steps: definition.steps.map((step) => ({
          relationshipTypes: step.relationshipTypes,
          direction: step.direction,
          arrivesAt: step.arrivesAt,
          ...(step.conditions === undefined ? {} : { conditions: step.conditions }),
          ...(step.window === undefined ? {} : windowInstantsOf(step.window, at)),
        })),
      };
      // a page above the source's `max_page` is refused by the run's own gate call before anything is read, so the estimate is not read first
      const aboveMaxPage = call.limit !== undefined && call.limit > source.budgets.maxPage;
      const limit = call.continue === true && !aboveMaxPage ? continueLimitOf(call.limit, source) : (call.limit ?? source.budgets.defaultPage);
      const run: GateRequest = { traceId: call.traceId, principal: call.principal, sourceId: call.sourceId, templateId: patternTemplate.id, params, limit, mask: call.mask, ...(call.signal === undefined ? {} : { signal: call.signal }) };
      const probe = call.continue === true || aboveMaxPage ? undefined : probes.get(patternTemplate.id);
      if (probe !== undefined) {
        const { estimate, heavy, threshold, notices } = await probeEstimateOf(deps.gate, run, params, probe, source, allowlist, `${PATTERN_SCOPE}:estimate`);
        if (heavy) return { status: 'heavy', templateVersion: patternTemplate.version, estimate, threshold, continueLimit: continueLimitOf(call.limit, source), notices: [...notices], warnings: [] };
      }
      const page = await gateRun(deps.gate, run);
      const [item] = page.items;
      if (item === undefined || !isNormalizedPattern(item) || !item.anchorFound) throw new AppError(item === undefined || isNormalizedPattern(item) ? 'NOT_FOUND' : 'INTERNAL_ERROR');
      const shown = new Set(item.nodes.map((node) => `${node.ref.entityType}\u0000${node.ref.stableId}`));
      const matches = item.matches
        .filter((entry) => shown.has(`${entry.match.entityType}\u0000${entry.match.stableId}`))
        .map((entry) => ({ match: entry.match, hops: entry.hops, through: [...entry.through], relationships: entry.relationships.map((hop) => ({ ...hop, relationshipType: hop.relationshipType === '' ? null : hop.relationshipType })) }));
      const count: Count = { value: matches.length, quality: patternCountQualityOf(item, page.hasMore), scope: PATTERN_SCOPE };
      return {
        status: 'ok',
        templateVersion: patternTemplate.version,
        count,
        matches,
        nodes: [...item.nodes],
        edges: [...item.edges],
        notices: patternNoticesOf(item, patternRequestOf(allowlist, params)),
        warnings: [...item.warnings],
      };
    },
  };
}
