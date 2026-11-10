import { AGGREGATE_MEMBERS_SCOPE, DERIVED_NEIGHBOR_CAP, NO_STABLE_ID, type AggregateEdgeRef, type DerivedEdgeRef, type EdgeRef, type ElementRef, type GraphEdge, type GraphNode, type ReadRefsRequest, type ReadRefsResponse, type StoredEdgeRef } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import { canonicalJson } from '../gate/cursor/binding.js';
import { isAggregateSample, isAggregateSummary } from '../gate/normalize/aggregate.js';
import { isNormalizedSupports } from '../gate/normalize/derived-run.js';
import type { Normalized } from '../gate/normalize/index.js';
import { AGGREGATE_SAMPLE_ID, AGGREGATE_SUMMARY_ID } from '../gate/templates/aggregate-evidence.js';
import { DERIVED_EDGE_SUPPORT_ID } from '../gate/templates/derived-edge-support.js';
import { EDGE_LOAD_ID } from '../gate/templates/edge-load.js';
import { ENTITY_LOAD_ID } from '../gate/templates/entity-load.js';
import type { Gate, GateRequest } from '../gate/types.js';
import type { SourceAccess } from '../investigations/source-access.js';
import type { MappingModel, SourceModel } from '../mapping/model.js';
import type { AuditSink, Principal } from '../seams/seams.js';

/** The audit action of a read by references; the reads inside it are audited by the gate under their own template's action. */
export const READ_REFS_AUDIT_ACTION = 'graph.read_refs';

export interface ReadRefsCall {
  readonly traceId: string;
  readonly principal: Principal;
  readonly request: ReadRefsRequest;
  /** Aborted when the client gives up the request. */
  readonly signal?: AbortSignal;
}

export interface ReadRefsService {
  read(call: ReadRefsCall): Promise<ReadRefsResponse>;
}

interface ReadRefsDeps {
  readonly gate: Gate;
  readonly mapping: MappingModel;
  readonly access: SourceAccess;
  readonly audit: AuditSink;
  readonly logger: { warn(fields: object, message: string): void };
}

const isNormalized = (item: unknown): item is Normalized => typeof item === 'object' && item !== null && 'nodes' in item && Array.isArray(item.nodes) && 'edges' in item && Array.isArray(item.edges);

const sameEntity = (left: ElementRef, right: ElementRef): boolean => left.sourceId === right.sourceId && left.entityType === right.entityType && left.stableId === right.stableId;

function distinct<T>(list: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const entry of list) seen.set(canonicalJson(entry), entry);
  return [...seen.values()];
}

/** A read the gate refuses answers `NOT_FOUND`, as every reader does, so a source the person may not read is never told apart from one that is not there. */
async function manyThrough(gate: Gate, requests: readonly GateRequest[]) {
  if (requests.length === 0) return [];
  try {
    return await gate.runMany(requests);
  } catch (error) {
    if (error instanceof AppError && error.code === 'ACCESS_DENIED') throw new AppError('NOT_FOUND');
    throw error;
  }
}

export function createReadRefsService(deps: ReadRefsDeps): ReadRefsService {
  async function entities(call: ReadRefsCall, source: SourceModel, refs: readonly ElementRef[]) {
    const { request } = call;
    const mapped = refs.filter((ref) => source.entities.some((type) => type.type === ref.entityType));
    const pages = await manyThrough(
      deps.gate,
      mapped.map((ref) => ({ traceId: call.traceId, principal: call.principal, sourceId: request.sourceId, templateId: ENTITY_LOAD_ID, params: { entityType: ref.entityType, stableId: ref.stableId }, limit: 1, mask: request.mask === true, ...(call.signal === undefined ? {} : { signal: call.signal }) })),
    );
    const found = new Map<ElementRef, GraphNode>();
    mapped.forEach((ref, index) => {
      const [item] = pages[index]?.items ?? [];
      const node = isNormalized(item) ? item.nodes.find((candidate) => candidate.ref.entityType === ref.entityType) : undefined;
      if (node !== undefined) found.set(ref, node);
    });
    return { nodes: refs.flatMap((ref) => found.get(ref) ?? []), missing: refs.filter((ref) => !found.has(ref)) };
  }

  async function storedEdges(call: ReadRefsCall, source: SourceModel, refs: readonly StoredEdgeRef[]) {
    const { request } = call;
    const mapped = refs.filter((ref) => source.relationships.some((row) => row.type === ref.type && row.from === ref.from && row.to === ref.to && row.stableId !== undefined));
    const pages = await manyThrough(
      deps.gate,
      mapped.map((ref) => ({ traceId: call.traceId, principal: call.principal, sourceId: request.sourceId, templateId: EDGE_LOAD_ID, params: { type: ref.type, from: ref.from, to: ref.to, stableId: ref.stableId }, limit: 1, mask: request.mask === true, ...(call.signal === undefined ? {} : { signal: call.signal }) })),
    );
    const found = new Map<StoredEdgeRef, GraphEdge>();
    mapped.forEach((ref, index) => {
      const [item] = pages[index]?.items ?? [];
      const edge = isNormalized(item) ? item.edges.find((candidate) => 'stableId' in candidate.ref) : undefined;
      if (edge !== undefined) found.set(ref, edge);
    });
    return { edges: refs.flatMap((ref) => found.get(ref) ?? []), missing: refs.filter((ref) => !found.has(ref)) };
  }

  /** An aggregate is read as its two ends and one member (so an end the person may not see ends the read as missing), and then as its member count and observed range, each kind of read in one lease. */
  async function aggregates(call: ReadRefsCall, source: SourceModel, refs: readonly AggregateEdgeRef[]) {
    const { request } = call;
    const mapped = refs.filter(({ aggregate }) => source.relationships.some((row) => row.type === aggregate.type && row.from === aggregate.from.entityType && row.to === aggregate.to.entityType));
    const ask = (templateId: string, limit: number, asked: readonly AggregateEdgeRef[]) =>
      manyThrough(
        deps.gate,
        asked.map(({ aggregate }) => ({ traceId: call.traceId, principal: call.principal, sourceId: request.sourceId, templateId, params: { type: aggregate.type, ends: [aggregate.from, aggregate.to] }, limit, mask: request.mask === true, ...(call.signal === undefined ? {} : { signal: call.signal }) })),
      );
    const sampled = await ask(AGGREGATE_SAMPLE_ID, 1, mapped);
    const present = mapped.filter(({ aggregate }, index) => {
      const [item] = sampled[index]?.items ?? [];
      return isAggregateSample(item) && item.aggregateSample.rows.length > 0 && item.nodes.some((node) => sameEntity(node.ref, aggregate.from)) && item.nodes.some((node) => sameEntity(node.ref, aggregate.to));
    });
    const summaries = await ask(AGGREGATE_SUMMARY_ID, 1, present);
    const found = new Map<AggregateEdgeRef, GraphEdge>();
    present.forEach((ref, index) => {
      const [item] = summaries[index]?.items ?? [];
      if (!isAggregateSummary(item)) return;
      const { members, first, last, mixed } = item.aggregateSummary;
      const row = source.relationships.find((candidate) => candidate.type === ref.aggregate.type && candidate.from === ref.aggregate.from.entityType && candidate.to === ref.aggregate.to.entityType);
      found.set(ref, {
        ref,
        memberCount: members === undefined ? { quality: 'unknown', scope: AGGREGATE_MEMBERS_SCOPE } : { value: members, quality: 'exact', scope: AGGREGATE_MEMBERS_SCOPE },
        from: ref.aggregate.from,
        to: ref.aggregate.to,
        type: ref.aggregate.type,
        direction: 'from-to',
        semantics: 'stored',
        ...(members === undefined || first === undefined ? {} : { observedFirst: first }),
        ...(members === undefined || last === undefined ? {} : { observedLast: last }),
        properties: [],
        evidenceRefs: [],
        qualityFlags: [...(row?.stableId === undefined ? [NO_STABLE_ID] : []), ...(members !== undefined && mixed ? ['mixed-time-kinds'] : [])],
      });
    });
    return { edges: refs.flatMap((ref) => found.get(ref) ?? []), missing: refs.filter((ref) => !found.has(ref)) };
  }

  /** A derived relationship is read again by its rule from the mapping, the pairs of one call in one lease, each with the cap of the derived-neighbor read; it comes back only when the rule still finds it. */
  async function derived(call: ReadRefsCall, source: SourceModel, refs: readonly DerivedEdgeRef[]) {
    const { request } = call;
    const ruled = (ref: DerivedEdgeRef): boolean => {
      const { ruleId, from, to } = ref.derived;
      const rule = source.derived.find((candidate) => candidate.id === ruleId);
      return rule !== undefined && rule.from === from.entityType && rule.to === to.entityType && !sameEntity(from, to);
    };
    const mapped = refs.filter(ruled);
    const limit = Math.min(DERIVED_NEIGHBOR_CAP, source.budgets.maxPage);
    const pages = await manyThrough(
      deps.gate,
      mapped.map(({ derived: held }) => ({ traceId: call.traceId, principal: call.principal, sourceId: request.sourceId, templateId: DERIVED_EDGE_SUPPORT_ID, params: { ruleId: held.ruleId, ends: [held.from, held.to] }, limit, mask: request.mask === true, ...(call.signal === undefined ? {} : { signal: call.signal }) })),
    );
    const found = new Map<DerivedEdgeRef, GraphEdge>();
    mapped.forEach((ref, index) => {
      const [item] = pages[index]?.items ?? [];
      if (!isNormalized(item) || !isNormalizedSupports(item) || item.chains.length === 0) return;
      const edge = item.edges.find((candidate) => candidate.semantics === 'derived' && 'derived' in candidate.ref && candidate.ref.derived.ruleId === ref.derived.ruleId && sameEntity(candidate.from, ref.derived.from) && sameEntity(candidate.to, ref.derived.to));
      if (edge?.derivation !== undefined) found.set(ref, edge);
    });
    return { edges: refs.flatMap((ref) => found.get(ref) ?? []), missing: refs.filter((ref) => !found.has(ref)) };
  }

  return {
    async read(call) {
      const { request } = call;
      const named = [
        ...request.entities.map((ref) => ref.sourceId),
        ...request.edges.map((ref) => ref.sourceId),
        ...request.aggregates.flatMap((ref) => [ref.sourceId, ref.aggregate.from.sourceId, ref.aggregate.to.sourceId]),
        ...request.derived.flatMap((ref) => [ref.sourceId, ref.derived.from.sourceId, ref.derived.to.sourceId]),
      ];
      if (named.some((sourceId) => sourceId !== request.sourceId)) throw new AppError('SOURCE_MISMATCH');
      await deps.access.require({ traceId: call.traceId, principal: call.principal, sourceId: request.sourceId, auditAction: READ_REFS_AUDIT_ACTION, rate: 'count' });
      const source = deps.mapping.sources.find((candidate) => candidate.id === request.sourceId);
      if (source === undefined) throw new AppError('NOT_FOUND');
      const found = await entities(call, source, distinct(request.entities));
      const stored = await storedEdges(call, source, distinct(request.edges));
      const grouped = await aggregates(call, source, distinct(request.aggregates));
      const ruled = await derived(call, source, distinct(request.derived));
      const response = { nodes: found.nodes, edges: [...stored.edges, ...grouped.edges, ...ruled.edges], missing: { entities: found.missing, edges: [...stored.missing, ...grouped.missing, ...ruled.missing] } };
      await recordRead(deps, call, [found.nodes.length, response.edges.length, found.missing.length + response.missing.edges.length]);
      return response;
    },
  };
}

async function recordRead(deps: ReadRefsDeps, call: ReadRefsCall, [nodes, edges, missing]: readonly [number, number, number]): Promise<void> {
  try {
    await deps.audit.record({ actorId: call.principal.id, actorRole: call.principal.role, action: READ_REFS_AUDIT_ACTION, result: 'success', sourceId: call.request.sourceId, traceId: call.traceId, detail: { counts: { nodes, edges, missing } } });
  } catch {
    // the answer does not depend on the audit write, as for a read through the gate; the log line carries no event data
    deps.logger.warn({ event: 'read_refs.audit_failed' }, 'read by references audit write failed');
  }
}

