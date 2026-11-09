import type { SourceLinkRef } from '@neburyx/contracts';
import type { FastifyBaseLogger } from 'fastify';
import { AppError, RequestCancelled } from '../errors.js';
import type { EdgeReader } from '../edges/edge-reader.js';
import type { EntityReader } from '../entities/entity-reader.js';
import type { SourceAccess } from '../investigations/source-access.js';
import { buildLinkAddress } from '../mapping/link-address.js';
import { isKeyed, type MappingModel } from '../mapping/model.js';
import type { ReferenceKeys } from '../reference/keys.js';
import { readToken } from '../reference/token.js';
import type { AuditEvent, AuditResult, AuditSink, Principal } from '../seams/seams.js';

export const SOURCE_LINK_AUDIT_ACTION = 'source.link';

export interface SourceLinkRequest {
  readonly traceId: string;
  readonly principal: Principal;
  readonly link: SourceLinkRef;
  /** Set for a stored edge: the record to open. */
  readonly record?: string | undefined;
  readonly mask: boolean;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly signal?: AbortSignal;
}

export interface SourceLinkService {
  /** The address to redirect to. The success audit event is written first; every refusal is the same `NOT_FOUND`. */
  open(request: SourceLinkRequest): Promise<string>;
}

interface Deps {
  readonly mapping: MappingModel;
  readonly access: SourceAccess;
  readonly entities: EntityReader;
  readonly edges: EdgeReader;
  readonly audit: AuditSink;
  readonly references: ReferenceKeys;
  readonly logger: Pick<FastifyBaseLogger, 'warn'>;
}

const SAME_SITE = new Set(['same-origin', 'none']);

const headerText = (value: string | string[] | undefined): string => (Array.isArray(value) ? value.join(',') : (value ?? '')).toLowerCase();

/** A request a page of another site started, or a browser's prefetch: neither is a person choosing the link. */
function isNotAClick(headers: SourceLinkRequest['headers']): boolean {
  const site = headerText(headers['sec-fetch-site']);
  if (site !== '' && !SAME_SITE.has(site)) return true;
  return headerText(headers['sec-purpose']).includes('prefetch') || headerText(headers['purpose']).includes('prefetch');
}

const refused = (): AppError => new AppError('NOT_FOUND');

function resultOf(error: unknown): AuditResult | undefined {
  if (error instanceof RequestCancelled) return undefined;
  if (error instanceof AppError && (error.code === 'NOT_FOUND' || error.code === 'INVALID_REQUEST')) return 'refused';
  return 'failed';
}

export function createSourceLinkService(deps: Deps): SourceLinkService {
  const event = (request: SourceLinkRequest, result: AuditResult, sourceId: string, detail: AuditEvent['detail']): AuditEvent => ({
    actorId: request.principal.id,
    actorRole: request.principal.role,
    action: SOURCE_LINK_AUDIT_ACTION,
    result,
    sourceId,
    traceId: request.traceId,
    ...(detail === undefined ? {} : { detail }),
  });

  async function recordFailure(request: SourceLinkRequest, error: unknown, sourceId: string, detail: AuditEvent['detail']): Promise<void> {
    const result = resultOf(error);
    if (result === undefined) return;
    try {
      await deps.audit.record(event(request, result, sourceId, detail));
    } catch {
      // the answer does not depend on the audit write of a refusal; the log line carries no event data
      deps.logger.warn({ event: 'source_link.audit_failed' }, 'audit write failed');
    }
  }

  async function entityAddress(request: SourceLinkRequest, ref: Extract<SourceLinkRef, { form: 'entity' }>['ref']): Promise<string> {
    const entity = deps.mapping.sources.find((source) => source.id === ref.sourceId)?.entities.find((candidate) => candidate.type === ref.entityType);
    if (entity?.link === undefined) throw refused();
    const keyed = isKeyed(entity);
    if (keyed && (request.mask || entity.link.carriesValue !== true)) throw refused();
    const node = await deps.entities.read({ traceId: request.traceId, principal: request.principal, sourceId: ref.sourceId, entityType: ref.entityType, stableId: ref.stableId, mask: request.mask, ...(request.signal === undefined ? {} : { signal: request.signal }) });
    if (keyed && node.properties.some((property) => property.key === entity.stableId && property.masked)) throw refused();
    const value = keyed ? readToken(deps.references, { sourceId: ref.sourceId, entityType: ref.entityType }, ref.stableId) : node.ref.stableId;
    const address = buildLinkAddress(entity.link, value);
    if (address === undefined) throw refused();
    return address;
  }

  async function recordAddress(request: SourceLinkRequest, ref: Extract<SourceLinkRef, { form: 'stored' }>['ref'], record: string): Promise<string> {
    const row = deps.mapping.sources.find((source) => source.id === ref.sourceId)?.relationships.find((candidate) => candidate.type === ref.type && candidate.from === ref.from && candidate.to === ref.to);
    if (row?.evidenceLink === undefined) throw refused();
    const detail = await deps.edges.read({ traceId: request.traceId, principal: request.principal, ref, mask: request.mask, ...(request.signal === undefined ? {} : { signal: request.signal }) });
    if (detail.evidence.status !== 'available') throw refused();
    const carried = detail.evidence.records.some((candidate) => !('unreadable' in candidate) && candidate.sourceRecordId === record && candidate.linkable);
    const address = carried ? buildLinkAddress(row.evidenceLink, record) : undefined;
    if (address === undefined) throw refused();
    return address;
  }

  return {
    async open(request) {
      const { link } = request;
      const sourceId = link.ref.sourceId;
      const detail: AuditEvent['detail'] = { target: link.form === 'entity' ? 'entity' : 'evidence', type: link.form === 'entity' ? link.ref.entityType : link.ref.type };
      await deps.access.require({ traceId: request.traceId, principal: request.principal, sourceId, auditAction: SOURCE_LINK_AUDIT_ACTION, rate: 'count' });
      let address: string;
      try {
        if (isNotAClick(request.headers)) throw refused();
        address = link.form === 'entity' ? await entityAddress(request, link.ref) : await recordAddress(request, link.ref, request.record ?? '');
      } catch (error) {
        await recordFailure(request, error, sourceId, detail);
        throw error;
      }
      try {
        await deps.audit.record(event(request, 'success', sourceId, detail));
      } catch {
        // no audit, no redirect: the audit is the reason the link goes through the app
        throw new AppError('INTERNAL_ERROR');
      }
      return address;
    },
  };
}
