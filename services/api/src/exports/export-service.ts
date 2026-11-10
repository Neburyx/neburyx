import { createHash, randomUUID } from 'node:crypto';
import { type ExportFormat, type ExportRecord, type ExportRequest, type GraphEdge, type GraphNode } from '@neburyx/contracts';
import type { ExportRow, ExportStore } from '../db/exports-repository.js';
import type { InvestigationStore } from '../db/investigations-repository.js';
import { AppError } from '../errors.js';
import type { SourceAccess } from '../investigations/source-access.js';
import type { MappingModel } from '../mapping/model.js';
import { retentionOf } from '../mapping/retention.js';
import type { AuditSink, PolicyProvider, Principal } from '../seams/seams.js';
import { entitiesCsvOf, relationshipsCsvOf } from './csv.js';
import { exportFilename, contentTypeOf } from './filename.js';
import { exportHeaderOf } from './header.js';
import { exportJsonOf } from './json-file.js';
import type { ExportFileStore } from './store.js';
import type { ShownReader } from './shown-reader.js';
import { zipOf } from './zip.js';

export const EXPORT_CREATE_AUDIT_ACTION = 'export.create';
export const EXPORT_DOWNLOAD_AUDIT_ACTION = 'export.download';
const ENTITIES_FILE = 'entities.csv';
const RELATIONSHIPS_FILE = 'relationships.csv';

interface Deps {
  readonly store: ExportStore & Pick<InvestigationStore, 'readInvestigation'>;
  readonly files: ExportFileStore;
  readonly reader: ShownReader;
  readonly mapping: MappingModel;
  readonly access: SourceAccess;
  readonly policy: PolicyProvider;
  readonly policyVersion: (sourceId: string) => string;
  readonly audit: AuditSink;
  readonly logger: { warn(fields: object, message: string): void };
  readonly clock?: () => Date;
}

export interface CreateExportCall {
  readonly traceId: string;
  readonly principal: Principal;
  readonly investigationId: string;
  readonly request: ExportRequest;
  readonly signal?: AbortSignal;
}

export interface ExportDownload {
  readonly bytes: Buffer;
  readonly filename: string;
  readonly contentType: string;
}

export interface ExportService {
  create(call: CreateExportCall): Promise<ExportRecord>;
  get(call: { readonly principal: Principal; readonly id: string }): Promise<ExportRecord>;
  download(call: { readonly traceId: string; readonly principal: Principal; readonly id: string }): Promise<ExportDownload>;
}

export function exportRecordOf(row: ExportRow): ExportRecord {
  if (row.format === 'png') throw new AppError('INTERNAL_ERROR');
  return { id: row.id, status: row.status, format: row.format, filename: row.filename, sizeBytes: row.sizeBytes, createdAt: row.createdAt, expiresAt: row.expiresAt };
}

export function exportBytesOf(format: ExportFormat, source: string, exportedAt: Date, read: { readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[]; readonly omitted: boolean; readonly maskedFields: number; readonly notRetrieved: Parameters<typeof exportHeaderOf>[0]['notRetrieved'] }): Buffer {
  const header = exportHeaderOf({ source, exportedAt, shown: read.nodes.length, notRetrieved: read.notRetrieved, maskedFields: read.maskedFields, omitted: read.omitted });
  if (format === 'json') return exportJsonOf(header, read.nodes, read.edges);
  return zipOf([
    { name: ENTITIES_FILE, bytes: entitiesCsvOf(header, read.nodes) },
    { name: RELATIONSHIPS_FILE, bytes: relationshipsCsvOf(header, read.edges) },
  ]);
}

export function createExportService(deps: Deps): ExportService {
  const now = deps.clock ?? (() => new Date());

  /** A failing audit sink fails the call closed: nothing is kept or handed out that the audit does not know of. */
  async function record(call: { readonly traceId: string; readonly principal: Principal; readonly sourceId: string; readonly action: string; readonly detail: { readonly format: 'json' | 'csv'; readonly entities?: number; readonly relationships?: number; readonly maskedFields?: number } }): Promise<void> {
    try {
      await deps.audit.record({ actorId: call.principal.id, actorRole: call.principal.role, action: call.action, result: 'success', sourceId: call.sourceId, traceId: call.traceId, detail: { export: call.detail } });
    } catch {
      deps.logger.warn({ event: 'export.audit_failed', action: call.action }, 'export audit write failed');
      throw new AppError('INTERNAL_ERROR');
    }
  }

  async function discard(id: string, storageKey: string | null, errorCode: string): Promise<void> {
    if (storageKey !== null) await deps.files.remove(storageKey).catch(() => undefined);
    await deps.store.failExport(id, errorCode).catch(() => undefined);
  }

  return {
    async create(call) {
      const stored = await deps.store.readInvestigation(call.investigationId, call.principal.id);
      if (stored === undefined) throw new AppError('NOT_FOUND');
      const sourceId = stored.investigation.sourceId;
      await deps.access.require({ traceId: call.traceId, principal: call.principal, sourceId, auditAction: EXPORT_CREATE_AUDIT_ACTION, rate: 'count' });

      const read = await deps.reader.read({ traceId: call.traceId, principal: call.principal, sourceId, entities: call.request.entities, edges: call.request.edges, aggregates: call.request.aggregates, derived: call.request.derived, ...(call.signal === undefined ? {} : { signal: call.signal }) });

      const exportedAt = now();
      const bytes = exportBytesOf(call.request.format, sourceId, exportedAt, read);
      const id = randomUUID();
      const row = await deps.store.insertExport({ id, investigationId: call.investigationId, requestedBy: call.principal.id, policyVersion: deps.policyVersion(sourceId), format: call.request.format, retentionDays: retentionOf(deps.mapping).exportsDays });

      let storageKey: string | null = null;
      try {
        if (call.signal?.aborted === true) throw new Error('cancelled');
        const written = await deps.files.write(id, bytes);
        storageKey = written.storageKey;
        await deps.store.completeExport(id, { filename: exportFilename(call.request.format, exportedAt), storageKey: written.storageKey, sizeBytes: written.sizeBytes, sha256: written.sha256, masked: read.maskedFields > 0, maskedFieldCount: read.maskedFields });
        await record({ traceId: call.traceId, principal: call.principal, sourceId, action: EXPORT_CREATE_AUDIT_ACTION, detail: { format: call.request.format, entities: read.nodes.length, relationships: read.edges.length, maskedFields: read.maskedFields } });
      } catch (error) {
        await discard(id, storageKey, 'EXPORT_FAILED');
        if (error instanceof AppError) throw error;
        throw new AppError('EXPORT_FAILED');
      }
      const done = await deps.store.readExport(id, call.principal.id);
      return exportRecordOf(done?.row ?? row);
    },

    async get(call) {
      const found = await deps.store.readExport(call.id, call.principal.id);
      if (found === undefined || found.investigation === undefined || found.investigation.deleted) throw new AppError('NOT_FOUND');
      return exportRecordOf(found.row);
    },

    async download(call) {
      const found = await deps.store.readExport(call.id, call.principal.id);
      if (found === undefined || found.investigation === undefined || found.investigation.deleted) throw new AppError('NOT_FOUND');
      const { row, investigation } = found;
      if (row.status !== 'ready' || row.storageKey === null || row.filename === null || (row.format !== 'json' && row.format !== 'csv')) throw new AppError('NOT_FOUND');
      if (found.expiredNow) {
        await deps.files.remove(row.storageKey).catch(() => undefined);
        await deps.store.expireExport(row.id);
        throw new AppError('NOT_FOUND');
      }

      const decision = await deps.policy.authorizeSource({ principal: call.principal, sourceId: investigation.sourceId });
      if (investigation.ownerId !== call.principal.id || !decision.allowed || deps.policyVersion(investigation.sourceId) !== row.policyVersion) {
        await deps.files.remove(row.storageKey).catch(() => undefined);
        await deps.store.expireExport(row.id);
        throw new AppError('ACCESS_DENIED', { reason: 'access-changed' });
      }

      const bytes = await deps.files.read(row.storageKey);
      if (bytes === undefined) {
        await deps.store.expireExport(row.id);
        throw new AppError('NOT_FOUND');
      }
      if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) {
        await discard(row.id, row.storageKey, 'EXPORT_FAILED');
        throw new AppError('INTERNAL_ERROR');
      }
      await record({ traceId: call.traceId, principal: call.principal, sourceId: investigation.sourceId, action: EXPORT_DOWNLOAD_AUDIT_ACTION, detail: { format: row.format } });
      return { bytes, filename: row.filename, contentType: contentTypeOf(row.format) };
    },
  };
}
