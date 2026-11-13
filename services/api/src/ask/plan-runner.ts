import { ASK_PLAN_PARAMS, parseExtensionRefusal, type AskPlanRun, type AskPlanRunner, type AskRunResult, type AskRunScope, type ExtensionRefusalFields } from '@neburyx/contracts';
import type { EdgeReader } from '../edges/edge-reader.js';
import type { EntityReader } from '../entities/entity-reader.js';
import { AppError, detailsOf, errorResponse } from '../errors.js';
import type { DegreePreviewService } from '../graph/degree-preview-service.js';
import type { DerivedNeighborsService } from '../graph/derived-neighbors-service.js';
import type { ExpandService } from '../graph/expand-service.js';
import type { TemplateRunService } from '../graph/template-run-service.js';
import type { MappingModel } from '../mapping/model.js';
import type { SearchService } from '../search/search-service.js';
import type { Principal } from '../seams/seams.js';

/** The services the manual routes use, each through the gate: a run of a plan is these and no other read. */
export interface AskPlanRunnerServices {
  readonly templateRuns: Pick<TemplateRunService, 'run'>;
  readonly entities: Pick<EntityReader, 'read'>;
  readonly degrees: Pick<DegreePreviewService, 'preview'>;
  readonly expansions: Pick<ExpandService, 'expand'>;
  readonly derivedNeighbors: Pick<DerivedNeighborsService, 'derive'>;
  readonly edges: Pick<EdgeReader, 'read'>;
  readonly searching: Pick<SearchService, 'search'>;
  readonly mapping: MappingModel;
}

/** What a run of a plan is for: who asked, the trace of the request and its abort signal, which are the request's own. */
export interface AskRunContext {
  readonly principal: Principal;
  readonly traceId: string;
  readonly signal?: AbortSignal;
}

const invalidPlan: ExtensionRefusalFields = { code: 'ASK_PLAN_INVALID' };

/**
 * The refusal an error of a service is, with the code and the details the manual route answers it with: only the errors of the gate and of the access check are, and `INVALID_REQUEST` (the service
 * refused the parameters a stored plan holds) is an invalid plan. Any other error is not a refusal and is not given back.
 */
export function refusalOfError(error: unknown): ExtensionRefusalFields | undefined {
  if (!(error instanceof AppError)) return undefined;
  if (error.code === 'INVALID_REQUEST') return invalidPlan;
  const details = errorResponse(error.code, '', detailsOf(error)).error.details;
  const fields = error.code === 'ACCESS_DENIED' ? {} : (details ?? {});
  return parseExtensionRefusal({ name: 'ExtensionRefusal', code: error.code, ...fields });
}

/**
 * The runner of plans for one request: it runs the template a plan names with the services of the manual routes, on the one source of its scope, as the caller, with the request's abort signal. A refusal of
 * the gate comes back as a refusal and never with part of a result; a failure that is not one of the gate's is thrown.
 */
export function createAskPlanRunnerFactory(services: AskPlanRunnerServices): (context: AskRunContext) => (scope: AskRunScope) => AskPlanRunner {
  return (context) => (scope) => ({
    async run(plan, options): Promise<AskPlanRun> {
      const base = { traceId: context.traceId, principal: context.principal, sourceId: scope.sourceId, mask: scope.mask, ...(context.signal === undefined ? {} : { signal: context.signal }) };
      try {
        const result = await runOf(services, base, plan, options?.continue === true);
        return result === undefined ? { status: 'refused', refusal: invalidPlan } : { status: 'ok', result };
      } catch (error) {
        const refusal = refusalOfError(error);
        if (refusal === undefined) throw error;
        return { status: 'refused', refusal };
      }
    },
  });
}

interface Base {
  readonly traceId: string;
  readonly principal: Principal;
  readonly sourceId: string;
  readonly mask: boolean;
  readonly signal?: AbortSignal;
}

/** The result of one plan, or undefined when the parameters it holds are not the template's. */
async function runOf(services: AskPlanRunnerServices, base: Base, plan: { readonly templateId: keyof typeof ASK_PLAN_PARAMS; readonly params: unknown }, continuing: boolean): Promise<AskRunResult | undefined> {
  switch (plan.templateId) {
    case 'shared-attribute':
    case 'linked-entities': {
      const parsed = ASK_PLAN_PARAMS[plan.templateId].safeParse(plan.params);
      if (!parsed.success) return undefined;
      const result = await services.templateRuns.run({ ...base, id: plan.templateId, params: parsed.data, continue: continuing });
      return { templateId: plan.templateId, result };
    }
    case 'entity': {
      const parsed = ASK_PLAN_PARAMS.entity.safeParse(plan.params);
      if (!parsed.success) return undefined;
      return { templateId: 'entity', result: await services.entities.read({ ...base, ...parsed.data.ref, rate: 'count' }) };
    }
    case 'degree-preview': {
      const parsed = ASK_PLAN_PARAMS['degree-preview'].safeParse(plan.params);
      if (!parsed.success) return undefined;
      return { templateId: 'degree-preview', result: await services.degrees.preview({ ...base, ...parsed.data.ref }) };
    }
    case 'expand': {
      const parsed = ASK_PLAN_PARAMS.expand.safeParse(plan.params);
      if (!parsed.success) return undefined;
      const { ref, relTypes, neighborTypes, direction, window, limit } = parsed.data;
      const result = await services.expansions.expand({ ...base, ...ref, ...(relTypes === undefined ? {} : { relTypes }), neighborTypes, direction: direction ?? 'both', ...(window === undefined ? {} : { window }), ...(limit === undefined ? {} : { limit }) });
      return { templateId: 'expand', result };
    }
    case 'derived-rule-run': {
      const parsed = ASK_PLAN_PARAMS['derived-rule-run'].safeParse(plan.params);
      if (!parsed.success) return undefined;
      const { ref, ruleId } = parsed.data;
      const rule = services.mapping.sources.find((source) => source.id === base.sourceId)?.derived.find((candidate) => candidate.id === ruleId);
      if (rule === undefined) return undefined;
      const answer = await services.derivedNeighbors.derive({ ...base, ...ref });
      const kept = answer.results.filter((result) => result.ruleId === ruleId);
      // a rule that gives no ends for this entity (its own type is another) answers with an exact zero, not an error
      const empty = { ruleId, ruleVersion: rule.ruleVersion, count: { quality: 'exact' as const, value: 0, scope: 'derived:neighbors' }, nodes: [], edges: [], warnings: [] };
      return { templateId: 'derived-rule-run', result: { ref: answer.ref, results: kept.length > 0 ? kept : [empty] } };
    }
    case 'derived-edge-support': {
      const parsed = ASK_PLAN_PARAMS['derived-edge-support'].safeParse(plan.params);
      if (!parsed.success) return undefined;
      const [from, to] = parsed.data.ends;
      const ref = { sourceId: base.sourceId, derived: { ruleId: parsed.data.ruleId, from: { sourceId: base.sourceId, ...from }, to: { sourceId: base.sourceId, ...to } } };
      const { traceId, principal, mask, signal } = base;
      return { templateId: 'derived-edge-support', result: await services.edges.read({ traceId, principal, mask, ref, rate: 'count', ...(signal === undefined ? {} : { signal }) }) };
    }
    case 'search': {
      const parsed = ASK_PLAN_PARAMS.search.safeParse(plan.params);
      if (!parsed.success) return undefined;
      return { templateId: 'search', result: await services.searching.search({ ...base, text: parsed.data.text, entityTypes: parsed.data.entityTypes }) };
    }
    default: {
      const unreachable: never = plan.templateId;
      return unreachable;
    }
  }
}
