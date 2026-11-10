import { AGGREGATE_MEMBERS_SCOPE, AGGREGATE_SAMPLE_SIZE, DERIVED_NEIGHBOR_CAP, EVIDENCE_NOT_AVAILABLE, NO_STABLE_ID, type AggregateEdgeDetail, type AggregateEdgeRef, type DerivedEdgeDetail, type DerivedEdgeRef, type DerivedSupport, type DerivedSupportGroup, type EdgeDetail, type EdgeEnd, type EdgeReadRef, type ElementRef, type GraphEdge, type GraphNode, type StoredEdgeDetail, type StoredEdgeRef } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import { isAggregateSample, isAggregateSummary } from '../gate/normalize/aggregate.js';
import { isNormalizedSupports } from '../gate/normalize/derived-run.js';
import { isNormalizedEvidence, type Normalized } from '../gate/normalize/index.js';
import { canonicalJson } from '../gate/cursor/binding.js';
import { AGGREGATE_SAMPLE_ID, AGGREGATE_SUMMARY_ID, aggregateSampleTemplate } from '../gate/templates/aggregate-evidence.js';
import { DERIVED_EDGE_SUPPORT_ID, derivedEdgeSupportTemplate } from '../gate/templates/derived-edge-support.js';
import { EDGE_LOAD_ID, edgeLoadTemplate } from '../gate/templates/edge-load.js';
import type { Gate } from '../gate/types.js';
import type { SourceAccess } from '../investigations/source-access.js';
import { buildLinkAddress } from '../mapping/link-address.js';
import type { MappingModel } from '../mapping/model.js';
import type { Principal } from '../seams/seams.js';

export interface EdgeReadRequest {
  readonly traceId: string;
  readonly principal: Principal;
  readonly ref: EdgeReadRef;
  readonly mask: boolean;
  /** Set by the route that is the request's own. */
  readonly rate?: 'count';
  /** Aborted when the client gives up the request. */
  readonly signal?: AbortSignal;
}

export interface EdgeReader {
  read(request: EdgeReadRequest & { readonly ref: StoredEdgeRef }): Promise<StoredEdgeDetail>;
  read(request: EdgeReadRequest & { readonly ref: DerivedEdgeRef }): Promise<DerivedEdgeDetail>;
  read(request: EdgeReadRequest & { readonly ref: AggregateEdgeRef }): Promise<AggregateEdgeDetail>;
  read(request: EdgeReadRequest): Promise<EdgeDetail>;
}

const ASKED_ROWS = 1;

function isNormalized(item: unknown): item is Normalized {
  return typeof item === 'object' && item !== null && 'edges' in item && Array.isArray(item.edges) && 'nodes' in item && Array.isArray(item.nodes);
}

const sameRef = (left: ElementRef, right: ElementRef): boolean => left.sourceId === right.sourceId && left.entityType === right.entityType && left.stableId === right.stableId;

function endOf(nodes: readonly GraphNode[], ref: ElementRef): EdgeEnd {
  const node = nodes.find((candidate) => sameRef(candidate.ref, ref));
  if (node === undefined) throw new AppError('INTERNAL_ERROR', undefined, 'unreadable-edge');
  return { ref: node.ref, title: node.display.title, type: node.display.type };
}

/** A read the gate refuses answers the same `NOT_FOUND` as a source the person may not read, so the two are never told apart; the gate has already recorded the denial. */
async function readThroughGate(gate: Gate, request: EdgeReadRequest & { readonly ref: StoredEdgeRef }) {
  try {
    return await gate.run({
      traceId: request.traceId,
      principal: request.principal,
      sourceId: request.ref.sourceId,
      templateId: EDGE_LOAD_ID,
      params: { type: request.ref.type, from: request.ref.from, to: request.ref.to, stableId: request.ref.stableId },
      limit: ASKED_ROWS,
      mask: request.mask,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  } catch (error) {
    if (error instanceof AppError && error.code === 'ACCESS_DENIED') throw new AppError('NOT_FOUND');
    throw error;
  }
}

const SUPPORTS_SCOPE = 'derived:supports';

export const COUNT_TIMED_OUT_WARNING = "The member count and observed range could not be read within the source's time limit.";
export const COUNT_BUSY_WARNING = 'The member count and observed range could not be read because the source was busy.';
export const COUNT_CHANGED_WARNING = 'The member count changed while the sample was read, so it is not shown.';

/** One of the two reads of an aggregate through the gate; a read the gate refuses answers `NOT_FOUND`, as the stored read does. */
async function readAggregateThroughGate(gate: Gate, request: EdgeReadRequest, ref: AggregateEdgeRef, templateId: string, limit: number) {
  try {
    return await gate.run({
      traceId: request.traceId,
      principal: request.principal,
      sourceId: ref.sourceId,
      templateId,
      params: { type: ref.aggregate.type, ends: [ref.aggregate.from, ref.aggregate.to] },
      limit,
      mask: request.mask,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  } catch (error) {
    if (error instanceof AppError && error.code === 'ACCESS_DENIED') throw new AppError('NOT_FOUND');
    throw error;
  }
}

const sameEntity = (left: ElementRef, right: ElementRef): boolean => sameRef(left, right);

/** A read the gate refuses answers `NOT_FOUND`, as the stored read does, so a hidden source and a refused read are never told apart. */
async function readSupportsThroughGate(gate: Gate, request: EdgeReadRequest, ref: DerivedEdgeRef, limit: number) {
  try {
    return await gate.run({
      traceId: request.traceId,
      principal: request.principal,
      sourceId: ref.sourceId,
      templateId: DERIVED_EDGE_SUPPORT_ID,
      params: { ruleId: ref.derived.ruleId, ends: [ref.derived.from, ref.derived.to] },
      limit,
      mask: request.mask,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  } catch (error) {
    if (error instanceof AppError && error.code === 'ACCESS_DENIED') throw new AppError('NOT_FOUND');
    throw error;
  }
}

export function createEdgeReader(deps: { readonly gate: Gate; readonly mapping: MappingModel; readonly access: SourceAccess }): EdgeReader {
  async function readStored(request: EdgeReadRequest & { readonly ref: StoredEdgeRef }): Promise<StoredEdgeDetail> {
    const { ref } = request;
    await deps.access.require({ traceId: request.traceId, principal: request.principal, sourceId: ref.sourceId, auditAction: edgeLoadTemplate.auditAction, ...(request.rate === undefined ? {} : { rate: request.rate }) });
    const page = await readThroughGate(deps.gate, request);
    const [item] = page.items;
    if (!isNormalized(item)) throw new AppError('INTERNAL_ERROR');
    const edge = item.edges.find((candidate) => 'stableId' in candidate.ref);
    if (edge === undefined || !('stableId' in edge.ref)) throw new AppError('NOT_FOUND');
    const storedEvidence = (isNormalizedEvidence(item) ? item.evidence : []).find((candidate) => 'stored' in candidate.of);
    const records = storedEvidence?.records ?? [];
    const row = deps.mapping.sources.find((source) => source.id === ref.sourceId)?.relationships.find((candidate) => candidate.type === ref.type && candidate.from === ref.from && candidate.to === ref.to);
    const linkTemplate = row?.evidenceLink;
    const linkable = (text: string): boolean => linkTemplate !== undefined && storedEvidence?.carriers?.[text]?.includes(linkTemplate.placeholder) === true && buildLinkAddress(linkTemplate, text) !== undefined;
    return {
      ref: edge.ref,
      type: edge.type,
      semantics: 'stored',
      from: endOf(item.nodes, edge.from),
      to: endOf(item.nodes, edge.to),
      ...(edge.observedAt === undefined ? {} : { observedAt: edge.observedAt }),
      properties: edge.properties.filter((property) => property.key !== row?.stableId && property.key !== row?.observedAt),
      qualityFlags: edge.qualityFlags,
      evidence: records.length === 0 ? { status: 'not-available', code: EVIDENCE_NOT_AVAILABLE } : { status: 'available', records: records.map((record) => ('unreadable' in record ? record : { sourceRecordId: record.sourceRecordId, linkable: linkable(record.sourceRecordId) })) },
    };
  }

  async function readDerived(request: EdgeReadRequest & { readonly ref: DerivedEdgeRef }): Promise<DerivedEdgeDetail> {
    const { ref } = request;
    await deps.access.require({ traceId: request.traceId, principal: request.principal, sourceId: ref.sourceId, auditAction: derivedEdgeSupportTemplate.auditAction, ...(request.rate === undefined ? {} : { rate: request.rate }) });
    const { from, to, ruleId } = ref.derived;
    const source = deps.mapping.sources.find((candidate) => candidate.id === ref.sourceId);
    const rule = source?.derived.find((candidate) => candidate.id === ruleId);
    if (source === undefined || rule === undefined || rule.from !== from.entityType || rule.to !== to.entityType || from.sourceId !== ref.sourceId || to.sourceId !== ref.sourceId || sameEntity(from, to)) throw new AppError('INVALID_REQUEST');
    // the effective cap of the derived-neighbor read: a source that lowered `max_page` lowers it, a raised one does not raise it
    const page = await readSupportsThroughGate(deps.gate, request, ref, Math.min(DERIVED_NEIGHBOR_CAP, source.budgets.maxPage));
    const [item] = page.items;
    if (!isNormalized(item) || !isNormalizedSupports(item)) throw new AppError('INTERNAL_ERROR');
    const derived = item.edges.find((candidate) => candidate.semantics === 'derived' && 'derived' in candidate.ref && candidate.ref.derived.ruleId === ruleId && sameEntity(candidate.from, from) && sameEntity(candidate.to, to));
    if (derived?.derivation === undefined || item.chains.length === 0) throw new AppError('NOT_FOUND');
    const edges = new Map<string, GraphEdge>(item.edges.filter((edge) => edge.semantics !== 'derived').map((edge) => [canonicalJson(edge.ref), edge]));
    const relationshipRows = source.relationships;
    const supportOf = (supportRef: GraphEdge['ref']): DerivedSupport => {
      const edge = edges.get(canonicalJson(supportRef));
      if (edge === undefined) throw new AppError('INTERNAL_ERROR', undefined, 'unreadable-edge');
      const ends = { from: endOf(item.nodes, edge.from), to: endOf(item.nodes, edge.to) };
      if ('aggregate' in edge.ref) return { ref: edge.ref, type: edge.ref.aggregate.type, ...ends, evidence: { status: NO_STABLE_ID } };
      if (!('stableId' in edge.ref)) throw new AppError('INTERNAL_ERROR', undefined, 'unreadable-edge');
      const stored = edge.ref;
      const supportEvidence = item.evidence.find((candidate) => 'stored' in candidate.of && canonicalJson(candidate.of.stored) === canonicalJson(stored));
      const records = supportEvidence?.records ?? [];
      const supportLink = relationshipRows.find((candidate) => candidate.type === stored.type && candidate.from === stored.from && candidate.to === stored.to)?.evidenceLink;
      const linkable = (text: string): boolean => supportLink !== undefined && supportEvidence?.carriers?.[text]?.includes(supportLink.placeholder) === true && buildLinkAddress(supportLink, text) !== undefined;
      return {
        ref: stored,
        type: edge.type,
        ...ends,
        evidence: records.length === 0 ? { status: 'not-available', code: EVIDENCE_NOT_AVAILABLE } : { status: 'available', records: records.map((record) => ('unreadable' in record ? record : { sourceRecordId: record.sourceRecordId, linkable: linkable(record.sourceRecordId) })) },
      };
    };
    const groups: DerivedSupportGroup[] = item.chains.map((chain) => ({ middle: chain.middle.map((middle) => endOf(item.nodes, middle)), supports: chain.supports.map(supportOf) }));
    const complete = !page.hasMore && item.lost === 0;
    return {
      ref: derived.ref as DerivedEdgeRef,
      type: ruleId,
      semantics: 'derived',
      rule: { id: ruleId, version: derived.derivation.ruleVersion },
      from: endOf(item.nodes, derived.from),
      to: endOf(item.nodes, derived.to),
      supports: { count: { value: groups.length, quality: complete ? 'exact' : 'lowerBound', scope: SUPPORTS_SCOPE }, groups },
      qualityFlags: derived.qualityFlags,
      warnings: item.warnings,
    };
  }

  async function readAggregate(request: EdgeReadRequest & { readonly ref: AggregateEdgeRef }): Promise<AggregateEdgeDetail> {
    const { ref } = request;
    await deps.access.require({ traceId: request.traceId, principal: request.principal, sourceId: ref.sourceId, auditAction: aggregateSampleTemplate.auditAction, ...(request.rate === undefined ? {} : { rate: request.rate }) });
    const { type, from, to } = ref.aggregate;
    const source = deps.mapping.sources.find((candidate) => candidate.id === ref.sourceId);
    const row = source?.relationships.find((candidate) => candidate.type === type && candidate.from === from.entityType && candidate.to === to.entityType);
    if (source === undefined || row === undefined || from.sourceId !== ref.sourceId || to.sourceId !== ref.sourceId) throw new AppError('INVALID_REQUEST');
    // the sample is the size of the effective cap: a source that lowered `max_page` lowers it, a raised one does not raise it
    const sampleSize = Math.min(AGGREGATE_SAMPLE_SIZE, source.budgets.maxPage);
    const sampled = (await readAggregateThroughGate(deps.gate, request, ref, AGGREGATE_SAMPLE_ID, sampleSize)).items[0];
    if (sampled === undefined) throw new AppError('NOT_FOUND');
    if (!isAggregateSample(sampled)) throw new AppError('INTERNAL_ERROR');
    const { rows, order } = sampled.aggregateSample;
    if (rows.length === 0) throw new AppError('NOT_FOUND');
    // an end the redact stage took out of the result is one the person may not see: the same answer as a missing one
    if (!sampled.nodes.some((node) => sameRef(node.ref, from)) || !sampled.nodes.some((node) => sameRef(node.ref, to))) throw new AppError('NOT_FOUND');
    let summary: { readonly members?: number; readonly first?: string; readonly last?: string; readonly mixed: boolean } | undefined;
    let warning: string | undefined;
    try {
      const item = (await readAggregateThroughGate(deps.gate, request, ref, AGGREGATE_SUMMARY_ID, 1)).items[0];
      if (item !== undefined && !isAggregateSummary(item)) throw new AppError('INTERNAL_ERROR');
      summary = item?.aggregateSummary;
    } catch (error) {
      if (!(error instanceof AppError) || (error.code !== 'QUERY_TIMEOUT' && error.code !== 'SOURCE_BUSY')) throw error;
      warning = error.code === 'QUERY_TIMEOUT' ? COUNT_TIMED_OUT_WARNING : COUNT_BUSY_WARNING;
    }
    const counted = summary?.members !== undefined && summary.members >= rows.length ? summary.members : undefined;
    if (warning === undefined && counted === undefined) warning = COUNT_CHANGED_WARNING;
    const flags = row.stableId === undefined ? [] : [NO_STABLE_ID];
    const range = counted === undefined || summary === undefined ? {} : { ...(summary.first === undefined ? {} : { observedFirst: summary.first }), ...(summary.last === undefined ? {} : { observedLast: summary.last }) };
    return {
      ref,
      type,
      semantics: 'aggregate',
      from: endOf(sampled.nodes, from),
      to: endOf(sampled.nodes, to),
      members: counted === undefined ? { quality: 'unknown', scope: AGGREGATE_MEMBERS_SCOPE } : { value: counted, quality: 'exact', scope: AGGREGATE_MEMBERS_SCOPE },
      ...range,
      sample: { order, rows: rows.map((member) => ({ ...(member.observedAt === undefined ? {} : { observedAt: member.observedAt }), properties: [...member.properties] })), ...(counted === undefined ? {} : { more: counted - rows.length }) },
      qualityFlags: [...flags, ...(counted !== undefined && summary?.mixed === true ? ['mixed-time-kinds'] : [])],
      warnings: [...sampled.warnings, ...(warning === undefined ? [] : [warning])],
    };
  }

  const reader = {
    read(request: EdgeReadRequest): Promise<EdgeDetail> {
      if ('derived' in request.ref) return readDerived({ ...request, ref: request.ref });
      if ('aggregate' in request.ref) return readAggregate({ ...request, ref: request.ref });
      return readStored({ ...request, ref: request.ref });
    },
  };
  return reader as EdgeReader;
}
