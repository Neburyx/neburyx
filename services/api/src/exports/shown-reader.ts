import { COVERAGE_MAX_ENTITIES, COVERAGE_SCOPE, MAX_READ_REFS, combineCoverage, type AggregateEdgeRef, type Count, type CoverageEntity, type DerivedEdgeRef, type ElementRef, type GraphEdge, type GraphNode, type StoredEdgeRef } from '@neburyx/contracts';
import { AppError, RequestCancelled } from '../errors.js';
import { canonicalJson } from '../gate/cursor/binding.js';
import { DEFAULT_BUDGETS } from '../gate/budgets.js';
import type { CoverageService } from '../graph/coverage-service.js';
import type { ReadRefsService } from '../graph/read-refs-service.js';
import type { Principal } from '../seams/seams.js';
import { MAX_EXPORT_ENTITIES, MAX_EXPORT_RELATIONSHIPS } from './limits.js';

export interface ShownReference {
  readonly entities: readonly ElementRef[];
  readonly edges: readonly StoredEdgeRef[];
  readonly aggregates: readonly AggregateEdgeRef[];
  readonly derived: readonly DerivedEdgeRef[];
}

export interface ShownReadCall extends ShownReference {
  readonly traceId: string;
  readonly principal: Principal;
  readonly sourceId: string;
  readonly signal?: AbortSignal;
}

export interface ShownRead {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** True when something was left out because the person may not export it; nothing says what or how many. */
  readonly omitted: boolean;
  /** How many distinct fields in the read items are masked. */
  readonly maskedFields: number;
  readonly notRetrieved: Count;
}

export interface ShownReaderLimits {
  readonly maxEntities: number;
  readonly maxRelationships: number;
  readonly batch: number;
  readonly requestTimeoutMs: number;
  readonly coverageChunk: number;
}

export const DEFAULT_SHOWN_LIMITS: ShownReaderLimits = {
  maxEntities: MAX_EXPORT_ENTITIES,
  maxRelationships: MAX_EXPORT_RELATIONSHIPS,
  batch: MAX_READ_REFS,
  requestTimeoutMs: DEFAULT_BUDGETS.requestTimeoutMs,
  coverageChunk: COVERAGE_MAX_ENTITIES,
};

export interface ShownReader {
  read(call: ShownReadCall): Promise<ShownRead>;
}

interface Deps {
  readonly readRefs: ReadRefsService;
  readonly coverage: CoverageService;
  readonly limits?: ShownReaderLimits;
}

const EMPTY_COUNT: Count = { value: 0, quality: 'exact', scope: COVERAGE_SCOPE };

function distinct<T>(list: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const entry of list) seen.set(canonicalJson(entry), entry);
  return [...seen.values()];
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
  return out;
}

const entityKey = (ref: ElementRef): string => `${ref.entityType}\u0000${ref.stableId}`;

/** What a loaded relationship counts for each of its ends, and how sure that count is. */
function loadedCounts(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): CoverageEntity[] {
  const loaded = new Map<string, { relationships: number; quality: CoverageEntity['loadedQuality'] }>();
  for (const node of nodes) loaded.set(entityKey(node.ref), { relationships: 0, quality: 'exact' });
  const weaker = (held: CoverageEntity['loadedQuality'], next: CoverageEntity['loadedQuality']): CoverageEntity['loadedQuality'] => (held === 'unknown' || next === 'unknown' ? 'unknown' : held === 'estimated' || next === 'estimated' ? 'estimated' : 'exact');
  for (const edge of edges) {
    const member = edge.memberCount;
    const count = member === undefined ? 1 : (member.value ?? 0);
    const quality: CoverageEntity['loadedQuality'] = member === undefined || member.quality === 'exact' ? 'exact' : member.quality === 'estimated' ? 'estimated' : 'unknown';
    for (const end of [edge.from, edge.to]) {
      const held = loaded.get(entityKey(end));
      if (held === undefined) continue;
      held.relationships += count;
      held.quality = weaker(held.quality, quality);
    }
  }
  return nodes.map((node) => {
    const held = loaded.get(entityKey(node.ref));
    return { ref: node.ref, loadedRelationships: held?.relationships ?? 0, loadedQuality: held?.quality ?? 'exact' };
  });
}

function maskedFieldsOf(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): number {
  const fields = new Set<string>();
  for (const node of nodes) for (const property of node.properties) if (property.masked) fields.add(`entity\u0000${node.display.type}\u0000${property.key}`);
  for (const edge of edges) for (const property of edge.properties) if (property.masked) fields.add(`relationship\u0000${edge.type}\u0000${property.key}`);
  return fields.size;
}

export function createShownReader(deps: Deps): ShownReader {
  const limits = deps.limits ?? DEFAULT_SHOWN_LIMITS;

  return {
    async read(call) {
      const entities = distinct(call.entities);
      const edges = distinct(call.edges);
      const aggregates = distinct(call.aggregates);
      const derived = distinct(call.derived);
      if (entities.length > limits.maxEntities || edges.length + aggregates.length + derived.length > limits.maxRelationships) {
        throw new AppError('INVALID_REQUEST', { reason: 'export-too-large', maxElements: Math.max(limits.maxEntities, limits.maxRelationships) });
      }

      const deadline = AbortSignal.timeout(limits.requestTimeoutMs);
      const signal = call.signal === undefined ? deadline : AbortSignal.any([call.signal, deadline]);
      const timedOut = (): AppError => new AppError('QUERY_TIMEOUT', { timeoutMs: limits.requestTimeoutMs });
      const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
        if (deadline.aborted && call.signal?.aborted !== true) throw timedOut();
        try {
          return await work();
        } catch (error) {
          if (error instanceof RequestCancelled && deadline.aborted && call.signal?.aborted !== true) throw timedOut();
          throw error;
        }
      };

      const nodes: GraphNode[] = [];
      const items: GraphEdge[] = [];
      const parts = {
        entities: chunks(entities, limits.batch),
        edges: chunks(edges, limits.batch),
        aggregates: chunks(aggregates, limits.batch),
        derived: chunks(derived, limits.batch),
      };
      const calls = Math.max(parts.entities.length, parts.edges.length, parts.aggregates.length, parts.derived.length);
      for (let index = 0; index < calls; index += 1) {
        const answer = await guarded(() =>
          deps.readRefs.read({
            traceId: call.traceId,
            principal: call.principal,
            signal,
            countRate: false,
            request: { sourceId: call.sourceId, entities: parts.entities[index] ?? [], edges: parts.edges[index] ?? [], aggregates: parts.aggregates[index] ?? [], derived: parts.derived[index] ?? [] },
          }),
        );
        nodes.push(...answer.nodes);
        items.push(...answer.edges);
      }

      const exportable = nodes.filter((node) => node.authorization.canExport);
      const refused = new Set(nodes.filter((node) => !node.authorization.canExport).map((node) => entityKey(node.ref)));
      const relationships = items.filter((edge) => !refused.has(entityKey(edge.from)) && !refused.has(entityKey(edge.to)));
      const omitted = exportable.length !== nodes.length || relationships.length !== items.length;

      let notRetrieved = EMPTY_COUNT;
      if (exportable.length > 0) {
        const wanted = loadedCounts(exportable, relationships);
        const answers: Count[] = [];
        for (const chunk of chunks(wanted, limits.coverageChunk)) {
          answers.push((await guarded(() => deps.coverage.coverage({ traceId: call.traceId, principal: call.principal, sourceId: call.sourceId, mask: false, entities: chunk, countRate: false }))).notRetrieved);
        }
        notRetrieved = combineCoverage(answers);
      }

      return { nodes: exportable, edges: relationships, omitted, maskedFields: maskedFieldsOf(exportable, relationships), notRetrieved };
    },
  };
}
