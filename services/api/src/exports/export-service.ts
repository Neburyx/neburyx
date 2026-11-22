import { createHash, randomUUID } from 'node:crypto';
import { type AuditTransaction, type CaseSummarizer, type CreateExportResponse, type ExportFormat, type ExportRecord, type ExportRequest, type ExportSummary, type GraphEdge, type GraphNode } from '@neburyx/contracts';
import type { ExportRow, ExportStore } from '../db/exports-repository.js';
import type { InvestigationStore } from '../db/investigations-repository.js';
import { AppError } from '../errors.js';
import { sourceStateOf } from '../investigations/investigation-service.js';
import { sourceChangedRefusal } from '../investigations/read-only.js';
import type { SourceAccess } from '../investigations/source-access.js';
import type { MappingModel } from '../mapping/model.js';
import { retentionOf } from '../mapping/retention.js';
import { identityHashOf } from '../registry/identity-hash.js';
import type { AuditSink, PolicyProvider, Principal } from '../seams/seams.js';
import { entitiesCsvOf, relationshipsCsvOf, summaryCsvOf } from './csv.js';
import { exportFilename, contentTypeOf } from './filename.js';
import { exportHeaderOf } from './header.js';
import { exportJsonOf } from './json-file.js';
import type { ExportFileStore } from './store.js';
import type { ShownReader } from './shown-reader.js';
import { zipOf } from './zip.js';

const EXPORT_CREATE_AUDIT_ACTION = 'export.create';
const EXPORT_DOWNLOAD_AUDIT_ACTION = 'export.download';
const ENTITIES_FILE = 'entities.csv';
const RELATIONSHIPS_FILE = 'relationships.csv';
const SUMMARY_FILE = 'summary.csv';

interface Deps {
  readonly store: ExportStore & Pick<InvestigationStore, 'readInvestigation'>;
  readonly files: ExportFileStore;
  readonly reader: ShownReader;
  readonly mapping: MappingModel;
  readonly access: SourceAccess;
  readonly policy: PolicyProvider;
  readonly policyVersion: (sourceId: string) => string;
  /** Where the events of the export and the download go: written directly, in the change's transaction where there is one, and a failure fails the call. */
  readonly audit: AuditSink;
  /** Where the events of a refusal go: queued, and never failing the refusal. */
  readonly refusalAudit: AuditSink;
  readonly logger: { warn(fields: object, message: string): void };
  /** The installed case summarizer, as the extension routes get it; read when a request carries a token. */
  readonly summarizer?: () => CaseSummarizer;
  /** Whether the AI preview is on: with it off a token is refused as when none is available. */
  readonly previewOn?: boolean;
  readonly clock?: () => Date;
}

interface CreateExportCall {
  readonly traceId: string;
  readonly principal: Principal;
  readonly investigationId: string;
  readonly request: ExportRequest;
  readonly signal?: AbortSignal;
}

interface ExportDownload {
  readonly bytes: Buffer;
  readonly filename: string;
  readonly contentType: string;
}

export interface ExportService {
  create(call: CreateExportCall): Promise<CreateExportResponse>;
  get(call: { readonly principal: Principal; readonly id: string }): Promise<ExportRecord>;
  download(call: { readonly traceId: string; readonly principal: Principal; readonly id: string }): Promise<ExportDownload>;
}

function exportRecordOf(row: ExportRow): ExportRecord {
  if (row.format === 'png') throw new AppError('INTERNAL_ERROR');
  return { id: row.id, status: row.status, format: row.format, filename: row.filename, sizeBytes: row.sizeBytes, createdAt: row.createdAt, expiresAt: row.expiresAt };
}

function exportBytesOf(format: ExportFormat, source: string, exportedAt: Date, requested: boolean, read: { readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[]; readonly omitted: boolean; readonly maskedFields: number; readonly notRetrieved: Parameters<typeof exportHeaderOf>[0]['notRetrieved']; readonly uncounted: number }, summary?: ExportSummary): Buffer {
  const header = exportHeaderOf({ source, exportedAt, shown: read.nodes.length, notRetrieved: read.notRetrieved, uncounted: read.uncounted, maskedFields: read.maskedFields, requested, omitted: read.omitted });
  if (format === 'json') return exportJsonOf(header, read.nodes, read.edges, summary);
  return zipOf([
    { name: ENTITIES_FILE, bytes: entitiesCsvOf(header, read.nodes) },
    { name: RELATIONSHIPS_FILE, bytes: relationshipsCsvOf(header, read.edges) },
    ...(summary === undefined ? [] : [{ name: SUMMARY_FILE, bytes: summaryCsvOf(header, summary, read.edges) }]),
  ]);
}

type ExportRead = Parameters<typeof exportBytesOf>[4] & { readonly unresolvedCount: number };

export function createExportService(deps: Deps): ExportService {
  const now = deps.clock ?? (() => new Date());

  /** A failing audit sink fails the call closed: nothing is kept or handed out that the audit does not know of. */
  async function record(call: { readonly traceId: string; readonly principal: Principal; readonly sourceId: string; readonly action: string; readonly detail: { readonly format: 'json' | 'csv' | 'png'; readonly entities?: number; readonly relationships?: number; readonly maskedFields?: number; readonly summary?: { readonly runId: string; readonly kept: number; readonly dropped: number } } }, transaction?: AuditTransaction): Promise<void> {
    try {
      await deps.audit.record({ actorId: call.principal.id, actorRole: call.principal.role, action: call.action, result: 'success', sourceId: call.sourceId, traceId: call.traceId, detail: { export: call.detail } }, transaction === undefined ? undefined : { transaction });
    } catch {
      deps.logger.warn({ event: 'export.audit_failed', action: call.action }, 'export audit write failed');
      throw new AppError('INTERNAL_ERROR');
    }
  }

  /** A refused download deletes the file, expires the export and is audited through the queue; the refusal stands whatever becomes of the event, since nothing is handed out either way. */
  async function refuseDownload(call: { readonly traceId: string; readonly principal: Principal }, row: ExportRow & { readonly storageKey: string; readonly format: 'json' | 'csv' }, sourceId: string, reason: 'access-changed' | 'export-source-changed'): Promise<never> {
    await deps.files.remove(row.storageKey).catch(() => undefined);
    await deps.store.expireExport(row.id);
    await deps.refusalAudit.record({ actorId: call.principal.id, actorRole: call.principal.role, action: EXPORT_DOWNLOAD_AUDIT_ACTION, result: 'refused', sourceId, traceId: call.traceId, detail: { export: { format: row.format, refusal: reason } } });
    throw new AppError('ACCESS_DENIED', { reason });
  }

  async function discard(id: string, storageKey: string | null, errorCode: string): Promise<void> {
    if (storageKey !== null) await deps.files.remove(storageKey).catch(() => undefined);
    await deps.store.failExport(id, errorCode).catch(() => undefined);
  }

  /** The summary section for the token of the request, from the export's own reading; every way it cannot be given is the one refusal, before any row or file exists. */
  function renderSummary(call: CreateExportCall, sourceId: string, read: ExportRead): { readonly section: ExportSummary; readonly runId: string; readonly kept: number; readonly dropped: number } {
    const summarizer = deps.summarizer?.();
    const token = call.request.summaryToken;
    if (token === undefined || deps.previewOn !== true || summarizer === undefined || summarizer.renderForExport === undefined || !summarizer.availability().available) throw new AppError('ACCESS_DENIED', { reason: 'summary-refused' });
    const outcome = summarizer.renderForExport({ token, investigationId: call.investigationId, actorId: call.principal.id, policyVersion: deps.policyVersion(sourceId), reading: { nodes: [...read.nodes], edges: [...read.edges], unresolved: read.unresolvedCount, omitted: read.omitted, notRetrieved: read.notRetrieved, uncounted: read.uncounted } });
    if (outcome.status !== 'ok') throw new AppError('ACCESS_DENIED', { reason: 'summary-refused' });
    return outcome;
  }

  return {
    async create(call) {
      const stored = await deps.store.readInvestigation(call.investigationId, call.principal.id);
      if (stored === undefined) throw new AppError('NOT_FOUND');
      const changed = sourceChangedRefusal(sourceStateOf(deps.mapping, stored.investigation));
      if (changed !== undefined) throw changed;
      const sourceId = stored.investigation.sourceId;
      await deps.access.require({ traceId: call.traceId, principal: call.principal, sourceId, auditAction: EXPORT_CREATE_AUDIT_ACTION, rate: 'count' });

      const { format } = call.request;
      const read = await deps.reader.read({ traceId: call.traceId, principal: call.principal, sourceId, ...(call.request.mask === undefined ? {} : { mask: call.request.mask }), entities: call.request.entities, edges: call.request.edges, aggregates: call.request.aggregates, derived: call.request.derived, ...(call.signal === undefined ? {} : { signal: call.signal }) });

      const exportedAt = now();
      if (format === 'png') {
        // the browser draws from its own view, so a view in which the read left something out would show more than a file would
        if (read.omitted || read.unresolved) throw new AppError('INVALID_REQUEST', { reason: 'export-view-changed' });
        const header = exportHeaderOf({ source: sourceId, exportedAt, shown: read.nodes.length, notRetrieved: read.notRetrieved, uncounted: read.uncounted, maskedFields: read.maskedFields, requested: call.request.mask === true, omitted: false });
        await record({ traceId: call.traceId, principal: call.principal, sourceId, action: EXPORT_CREATE_AUDIT_ACTION, detail: { format, entities: read.nodes.length, relationships: read.edges.length, maskedFields: read.maskedFields } });
        return { format, filename: exportFilename(format, exportedAt), header };
      }
      let included: ReturnType<typeof renderSummary> | undefined;
      if (call.request.summaryToken !== undefined) {
        try {
          included = renderSummary(call, sourceId, read);
        } catch (error) {
          // the refusal says nothing of which check failed
          await deps.refusalAudit.record({ actorId: call.principal.id, actorRole: call.principal.role, action: EXPORT_CREATE_AUDIT_ACTION, result: 'refused', sourceId, traceId: call.traceId, detail: { export: { format, refusal: 'summary-refused' } } });
          throw error;
        }
      }
      const bytes = exportBytesOf(format, sourceId, exportedAt, call.request.mask === true, read, included?.section);
      const id = randomUUID();
      const row = await deps.store.insertExport({ id, investigationId: call.investigationId, requestedBy: call.principal.id, policyVersion: deps.policyVersion(sourceId), sourceIdentityHash: stored.investigation.sourceIdentityHash, format, retentionDays: retentionOf(deps.mapping).exportsDays });

      let storageKey: string | null = null;
      try {
        if (call.signal?.aborted === true) throw new Error('cancelled');
        const written = await deps.files.write(id, bytes);
        storageKey = written.storageKey;
        await deps.store.completeExport(id, { filename: exportFilename(format, exportedAt), storageKey: written.storageKey, sizeBytes: written.sizeBytes, sha256: written.sha256, masked: call.request.mask === true || read.maskedFields > 0, maskedFieldCount: read.maskedFields }, (transaction) =>
          record({ traceId: call.traceId, principal: call.principal, sourceId, action: EXPORT_CREATE_AUDIT_ACTION, detail: { format, entities: read.nodes.length, relationships: read.edges.length, maskedFields: read.maskedFields, ...(included === undefined ? {} : { summary: { runId: included.runId, kept: included.kept, dropped: included.dropped } }) } }, transaction),
        );
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

      const refusable = { ...row, storageKey: row.storageKey, format: row.format };
      const source = deps.mapping.sources.find((candidate) => candidate.id === investigation.sourceId);
      // an export made before the identity was recorded cannot be shown to come from the source as it is, so it is refused
      if (source === undefined || row.sourceIdentityHash === null || identityHashOf(source) !== row.sourceIdentityHash) {
        return refuseDownload(call, refusable, investigation.sourceId, 'export-source-changed');
      }

      const decision = await deps.policy.authorizeSource({ principal: call.principal, sourceId: investigation.sourceId });
      if (investigation.ownerId !== call.principal.id || !decision.allowed || deps.policyVersion(investigation.sourceId) !== row.policyVersion) {
        return refuseDownload(call, refusable, investigation.sourceId, 'access-changed');
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
