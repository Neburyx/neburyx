import { ASK_TEMPLATE_PARAMS, FILE_QUERY_RESULT_ID, SAVED_PATTERN_TEMPLATE_ID, parseExtensionRefusal, storedSavedPatternParamsSchema, type AskRun, type AskRunner, type AskRunInput, type AskRunResult, type AskRunScope, type ExtensionRefusalFields, type FileQueryResult } from '@neburyx/contracts';
import type { EdgeReader } from '../edges/edge-reader.js';
import type { EntityReader } from '../entities/entity-reader.js';
import { AppError, detailsOf, errorResponse } from '../errors.js';
import type { DegreePreviewService } from '../graph/degree-preview-service.js';
import type { DerivedNeighborsService } from '../graph/derived-neighbors-service.js';
import type { ExpandService } from '../graph/expand-service.js';
import type { PathsService } from '../graph/paths-service.js';
import type { TemplateRunService } from '../graph/template-run-service.js';
import type { MappingModel } from '../mapping/model.js';
import type { SavedPatternRunService } from '../patterns/saved-run-service.js';
import type { FileQueryRequest } from '../gate/types.js';
import type { SearchService } from '../search/search-service.js';
import type { Principal } from '../seams/seams.js';

/** The services the manual routes use, each through the gate: a run is these and no other read. */
export interface AskRunnerServices {
  readonly templateRuns: Pick<TemplateRunService, 'run'>;
  readonly entities: Pick<EntityReader, 'read'>;
  readonly degrees: Pick<DegreePreviewService, 'preview'>;
  readonly expansions: Pick<ExpandService, 'expand'>;
  readonly derivedNeighbors: Pick<DerivedNeighborsService, 'derive'>;
  readonly edges: Pick<EdgeReader, 'read'>;
  readonly searching: Pick<SearchService, 'search'>;
  readonly paths: Pick<PathsService, 'find'>;
  readonly savedRuns: Pick<SavedPatternRunService, 'find' | 'run'>;
  /** The file queries of the operator's Ask folder, through the gate. */
  readonly fileQueries: { run(request: FileQueryRequest): Promise<FileQueryResult> };
  readonly mapping: MappingModel;
}

/** What a run is for: who asked, the trace of the request and its abort signal, which are the request's own. */
export interface AskRunContext {
  readonly principal: Principal;
  readonly traceId: string;
  readonly signal?: AbortSignal;
}

const invalidRun: ExtensionRefusalFields = { code: 'ASK_INTENT_INVALID' };

/**
 * The refusal an error of a service is, with the code and the details the manual route answers it with: only the errors of the gate and of the access check are, and `INVALID_REQUEST` (the service
 * refused the parameters of the run) is invalid parameters. Any other error is not a refusal and is not given back.
 */
export function refusalOfError(error: unknown): ExtensionRefusalFields | undefined {
  if (!(error instanceof AppError)) return undefined;
  if (error.code === 'INVALID_REQUEST') {
    // the refusals of a file query say which rule refused it; any other refusal of the parameters is an invalid one
    const details = detailsOf(error);
    const reason: unknown = typeof details === 'object' && details !== null && 'reason' in details ? details.reason : undefined;
    return typeof reason === 'string' && reason.startsWith('file-query-') ? parseExtensionRefusal({ name: 'ExtensionRefusal', code: 'INVALID_REQUEST', reason }) ?? invalidRun : invalidRun;
  }
  const details = errorResponse(error.code, '', detailsOf(error)).error.details;
  const fields = error.code === 'ACCESS_DENIED' ? {} : (details ?? {});
  return parseExtensionRefusal({ name: 'ExtensionRefusal', code: error.code, ...fields });
}

/**
 * The runner for one request: it runs the template a question's intent names with the services of the manual routes, on the one source of its scope, as the caller, with the request's abort signal. A refusal of
 * the gate comes back as a refusal and never with part of a result; a failure that is not one of the gate's is thrown.
 */
export function createAskRunnerFactory(services: AskRunnerServices): (context: AskRunContext) => (scope: AskRunScope) => AskRunner {
  return (context) => (scope) => ({
    async run(asked, options): Promise<AskRun> {
      const base = { traceId: context.traceId, principal: context.principal, sourceId: scope.sourceId, mask: scope.mask, ...(context.signal === undefined ? {} : { signal: context.signal }) };
      try {
        const result = await runOf(services, base, asked, options?.continue === true);
        return result === undefined ? { status: 'refused', refusal: invalidRun } : { status: 'ok', result };
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

/** The result of one input, a template run or a file query, or undefined when the parameters it holds are not the template's. */
async function runOf(services: AskRunnerServices, base: Base, asked: AskRunInput, continuing: boolean): Promise<AskRunResult | undefined> {
  if ('fileQuery' in asked) {
    const result = await services.fileQueries.run({ traceId: base.traceId, principal: base.principal, sourceId: base.sourceId, intent: asked.fileQuery.intent, values: asked.fileQuery.values, mask: base.mask, ...(base.signal === undefined ? {} : { signal: base.signal }) });
    return { templateId: FILE_QUERY_RESULT_ID, result };
  }
  switch (asked.templateId) {
    case 'shared-attribute':
    case 'linked-entities': {
      const parsed = ASK_TEMPLATE_PARAMS[asked.templateId].safeParse(asked.params);
      if (!parsed.success) return undefined;
      const result = await services.templateRuns.run({ ...base, id: asked.templateId, params: parsed.data, continue: continuing });
      return { templateId: asked.templateId, result };
    }
    case SAVED_PATTERN_TEMPLATE_ID: {
      const parsed = storedSavedPatternParamsSchema.safeParse(asked.params);
      if (!parsed.success) return undefined;
      const { patternId, patternVersion, ref } = parsed.data;
      // the pattern is read again as the saved run reads it, so a pattern that is unshared, deleted or no longer the caller's is as absent as it is to the manual route; the version of this very row is the one compared
      const pattern = await services.savedRuns.find({ principal: base.principal, id: patternId });
      if (pattern.sourceId !== base.sourceId) throw new AppError('NOT_FOUND');
      if (pattern.version !== patternVersion) throw new AppError('CONFLICT', { reason: 'pattern-changed' });
      const answer = await services.savedRuns.run({ traceId: base.traceId, principal: base.principal, pattern, mask: base.mask, ...(ref === undefined ? {} : { anchor: ref }), continue: continuing, ...(base.signal === undefined ? {} : { signal: base.signal }) });
      if (answer.status === 'unavailable') throw new AppError('CONFLICT', { reason: 'pattern-unavailable' });
      return { templateId: SAVED_PATTERN_TEMPLATE_ID, result: answer };
    }
    case 'entity': {
      const parsed = ASK_TEMPLATE_PARAMS.entity.safeParse(asked.params);
      if (!parsed.success) return undefined;
      return { templateId: 'entity', result: await services.entities.read({ ...base, ...parsed.data.ref, rate: 'count' }) };
    }
    case 'degree-preview': {
      const parsed = ASK_TEMPLATE_PARAMS['degree-preview'].safeParse(asked.params);
      if (!parsed.success) return undefined;
      return { templateId: 'degree-preview', result: await services.degrees.preview({ ...base, ...parsed.data.ref }) };
    }
    case 'expand': {
      const parsed = ASK_TEMPLATE_PARAMS.expand.safeParse(asked.params);
      if (!parsed.success) return undefined;
      const { ref, relTypes, neighborTypes, direction, window, limit } = parsed.data;
      const result = await services.expansions.expand({ ...base, ...ref, ...(relTypes === undefined ? {} : { relTypes }), neighborTypes, direction: direction ?? 'both', ...(window === undefined ? {} : { window }), ...(limit === undefined ? {} : { limit }) });
      return { templateId: 'expand', result };
    }
    case 'derived-rule-run': {
      const parsed = ASK_TEMPLATE_PARAMS['derived-rule-run'].safeParse(asked.params);
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
      const parsed = ASK_TEMPLATE_PARAMS['derived-edge-support'].safeParse(asked.params);
      if (!parsed.success) return undefined;
      const [from, to] = parsed.data.ends;
      const ref = { sourceId: base.sourceId, derived: { ruleId: parsed.data.ruleId, from: { sourceId: base.sourceId, ...from }, to: { sourceId: base.sourceId, ...to } } };
      const { traceId, principal, mask, signal } = base;
      return { templateId: 'derived-edge-support', result: await services.edges.read({ traceId, principal, mask, ref, rate: 'count', ...(signal === undefined ? {} : { signal }) }) };
    }
    case 'search': {
      const parsed = ASK_TEMPLATE_PARAMS.search.safeParse(asked.params);
      if (!parsed.success) return undefined;
      return { templateId: 'search', result: await services.searching.search({ ...base, text: parsed.data.text, entityTypes: parsed.data.entityTypes }) };
    }
    case 'shortest-paths': {
      const parsed = ASK_TEMPLATE_PARAMS['shortest-paths'].safeParse(asked.params);
      if (!parsed.success) return undefined;
      const { ends: [from, to], relTypes, maxHops, limit, direction } = parsed.data;
      return { templateId: 'shortest-paths', result: await services.paths.find({ ...base, from, to, relTypes, maxHops, limit, ...(direction === undefined ? {} : { direction }), continue: continuing }) };
    }
    default: {
      const unreachable: never = asked.templateId;
      return unreachable;
    }
  }
}
