import type { Count, GraphEdge, GraphNode, PathsRequest, PathsResponse } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import { allowlistFromMapping } from '../gate/allowlist.js';
import { isNormalizedPaths, type FoundStep } from '../gate/normalize/shortest-paths.js';
import { shortestPathsTemplate, SHORTEST_PATHS_ID } from '../gate/templates/shortest-paths.js';
import { PATHS_MAX_HOPS } from '../gate/templates/shortest-paths-statement.js';
import type { Gate, GateRequest, Params } from '../gate/types.js';
import type { SourceAccess } from '../investigations/source-access.js';
import type { MappingModel } from '../mapping/model.js';
import type { Principal } from '../seams/seams.js';
import { defaultTemplateProbes, type TemplateProbe } from './template-probes.js';
import { continueLimitOf, gateRun, probeEstimateOf } from './template-run-service.js';

interface PathsServiceRequest extends Omit<PathsRequest, 'mask'> {
  readonly traceId: string;
  readonly principal: Principal;
  readonly mask: boolean;
  readonly signal?: AbortSignal;
}

export interface PathsService {
  find(request: PathsServiceRequest): Promise<PathsResponse>;
}

const keyOf = (ref: { readonly entityType: string; readonly stableId: string }): string => `${ref.entityType}\u0000${ref.stableId}`;

/** The nodes the kept paths cross and the relationships they walk, so that the answer holds nothing of a path that was cut. */
function shownBy(paths: readonly (readonly FoundStep[])[], nodes: readonly GraphNode[], edges: readonly GraphEdge[]): { readonly nodes: GraphNode[]; readonly edges: GraphEdge[] } {
  const steps = paths.flat();
  const refs = new Set(steps.flatMap((step) => [keyOf(step.from), keyOf(step.to)]));
  const walked = (edge: GraphEdge): boolean =>
    steps.some(
      (step) =>
        step.relationshipType === edge.type &&
        ((keyOf(step.from) === keyOf(edge.from) && keyOf(step.to) === keyOf(edge.to)) || (keyOf(step.from) === keyOf(edge.to) && keyOf(step.to) === keyOf(edge.from))) &&
        (step.stableId === undefined || !('stableId' in edge.ref) || edge.ref.stableId === step.stableId),
    );
  return { nodes: nodes.filter((node) => refs.has(keyOf(node.ref))), edges: edges.filter(walked) };
}

export function createPathsService(deps: { readonly gate: Gate; readonly mapping: MappingModel; readonly access: SourceAccess; readonly now?: () => Date; readonly probes?: ReadonlyMap<string, TemplateProbe> }): PathsService {
  const probe = (deps.probes ?? defaultTemplateProbes()).get(SHORTEST_PATHS_ID);
  const allowlists = new Map(deps.mapping.sources.map((source) => [source.id, allowlistFromMapping(source)]));
  const now = deps.now ?? (() => new Date());
  return {
    async find(request) {
      const started = now().getTime();
      await deps.access.require({ traceId: request.traceId, principal: request.principal, sourceId: request.sourceId, auditAction: shortestPathsTemplate.auditAction, rate: 'count' });
      const [allowlist, source] = [allowlists.get(request.sourceId), deps.mapping.sources.find((candidate) => candidate.id === request.sourceId)];
      if (allowlist === undefined || source === undefined) throw new AppError('NOT_FOUND');
      const ends = [request.from, request.to].map((end) => ({ sourceId: request.sourceId, entityType: end.entityType, stableId: end.stableId }));
      // a request beyond the bounds is refused by the run's own gate call before anything is read, so no estimate is read for it, and a continue does not shrink it into range
      const beyondBounds = request.maxHops > Math.min(PATHS_MAX_HOPS, source.budgets.maxHops) || request.limit > source.budgets.pathResultsCap || request.limit > source.budgets.maxPage;
      const continueLimit = Math.min(continueLimitOf(request.limit, source), source.budgets.pathResultsCap);
      const params: Params = { ends, via: request.relTypes, maxHops: request.maxHops, ...(request.direction === undefined ? {} : { direction: request.direction }) };
      const gateRequest: GateRequest = {
        traceId: request.traceId,
        principal: request.principal,
        sourceId: request.sourceId,
        templateId: SHORTEST_PATHS_ID,
        params,
        limit: request.continue === true && !beyondBounds ? continueLimit : request.limit,
        mask: request.mask,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      };
      let estimate: Count | undefined;
      if (request.continue !== true && !beyondBounds && probe !== undefined) {
        const probed = await probeEstimateOf(deps.gate, gateRequest, params, probe, source, allowlist, 'paths:estimate');
        if (probed.heavy) return { status: 'heavy', estimate: probed.estimate, threshold: probed.threshold, continueLimit, warnings: [] };
        estimate = probed.estimate;
      }
      const page = await gateRun(deps.gate, gateRequest);
      const [item] = page.items;
      if (item === undefined || !isNormalizedPaths(item)) throw new AppError('INTERNAL_ERROR');
      if (!item.fromFound || !item.toFound) throw new AppError('NOT_FOUND');
      const limit = gateRequest.limit;
      const kept = item.paths.slice(0, limit);
      const partial = page.partial === true;
      const shown = shownBy(kept, item.nodes, item.edges);
      return {
        status: 'ok',
        paths: kept.map((steps) => ({ hops: steps.length, steps: steps.map((step) => ({ from: step.from, to: step.to, relationshipType: step.relationshipType, evidenceRefs: [...step.evidenceRefs] })) })),
        nodes: shown.nodes,
        edges: shown.edges,
        capReached: !partial && page.hasMore,
        partial,
        ...(partial ? { retained: kept.length, requested: limit } : {}),
        elapsedMs: Math.max(0, now().getTime() - started),
        ...(estimate === undefined ? {} : { estimate }),
        warnings: [...item.warnings],
      };
    },
  };
}
