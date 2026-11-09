import { EVIDENCE_NOT_AVAILABLE, type EdgeDetail, type EdgeEnd, type ElementRef, type GraphNode, type StoredEdgeRef } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import { isNormalizedEvidence, type Normalized } from '../gate/normalize/index.js';
import { EDGE_LOAD_ID, edgeLoadTemplate } from '../gate/templates/edge-load.js';
import type { Gate } from '../gate/types.js';
import type { SourceAccess } from '../investigations/source-access.js';
import type { MappingModel } from '../mapping/model.js';
import type { Principal } from '../seams/seams.js';

export interface EdgeReadRequest {
  readonly traceId: string;
  readonly principal: Principal;
  readonly ref: StoredEdgeRef;
  readonly mask: boolean;
  /** Set by the route that is the request's own. */
  readonly rate?: 'count';
  /** Aborted when the client gives up the request. */
  readonly signal?: AbortSignal;
}

export interface EdgeReader {
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
async function readThroughGate(gate: Gate, request: EdgeReadRequest) {
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

export function createEdgeReader(deps: { readonly gate: Gate; readonly mapping: MappingModel; readonly access: SourceAccess }): EdgeReader {
  return {
    async read(request) {
      const { ref } = request;
      await deps.access.require({ traceId: request.traceId, principal: request.principal, sourceId: ref.sourceId, auditAction: edgeLoadTemplate.auditAction, ...(request.rate === undefined ? {} : { rate: request.rate }) });
      const page = await readThroughGate(deps.gate, request);
      const [item] = page.items;
      if (!isNormalized(item)) throw new AppError('INTERNAL_ERROR');
      const edge = item.edges.find((candidate) => 'stableId' in candidate.ref);
      if (edge === undefined || !('stableId' in edge.ref)) throw new AppError('NOT_FOUND');
      const records = (isNormalizedEvidence(item) ? item.evidence : []).find((candidate) => 'stored' in candidate.of)?.records ?? [];
      const row = deps.mapping.sources.find((source) => source.id === ref.sourceId)?.relationships.find((candidate) => candidate.type === ref.type && candidate.from === ref.from && candidate.to === ref.to);
      const linkable = row?.evidenceLink !== undefined;
      return {
        ref: edge.ref,
        type: edge.type,
        semantics: 'stored',
        from: endOf(item.nodes, edge.from),
        to: endOf(item.nodes, edge.to),
        ...(edge.observedAt === undefined ? {} : { observedAt: edge.observedAt }),
        properties: edge.properties.filter((property) => property.key !== row?.stableId && property.key !== row?.observedAt),
        qualityFlags: edge.qualityFlags,
        evidence: records.length === 0 ? { status: 'not-available', code: EVIDENCE_NOT_AVAILABLE } : { status: 'available', records: records.map((record) => ('unreadable' in record ? record : { sourceRecordId: record.sourceRecordId, linkable })) },
      };
    },
  };
}
