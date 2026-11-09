import { DERIVED_NEIGHBOR_CAP, EVIDENCE_NOT_AVAILABLE, NO_STABLE_ID, type DerivedEdgeDetail, type DerivedEdgeRef, type DerivedSupport, type DerivedSupportGroup, type EdgeDetail, type EdgeEnd, type EdgeReadRef, type ElementRef, type GraphEdge, type GraphNode, type StoredEdgeDetail, type StoredEdgeRef } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import { isNormalizedSupports } from '../gate/normalize/derived-run.js';
import { isNormalizedEvidence, type Normalized } from '../gate/normalize/index.js';
import { canonicalJson } from '../gate/cursor/binding.js';
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

  const reader = {
    read(request: EdgeReadRequest): Promise<EdgeDetail> {
      return 'derived' in request.ref ? readDerived({ ...request, ref: request.ref }) : readStored({ ...request, ref: request.ref });
    },
  };
  return reader as EdgeReader;
}
