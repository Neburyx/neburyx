import { SYSTEM_ACTOR_ID, auditDetailSchema, type AuditEvent, type AuditSinkContext, type MountedAuditSink } from '@neburyx/contracts';
import pg from 'pg';

const INSERT = `INSERT INTO audit_events (id, actor_id, actor_role, action, result, source_id, investigation_id, resource_type, resource_ref, trace_id, detail)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`;
const SYSTEM_ACTOR = 'system';

export type AuditSinkErrorCode = 'AUDIT_DETAIL_REFUSED' | 'AUDIT_WRITE_FAILED';

/** What a refused or failed write says: a fixed code and message, never the event, the driver's text or a value. */
export class AuditSinkError extends Error {
  readonly code: AuditSinkErrorCode;

  constructor(code: AuditSinkErrorCode) {
    super(code === 'AUDIT_DETAIL_REFUSED' ? 'the audit event detail is not one of the known shapes' : 'the audit event could not be written');
    this.code = code;
  }
}

/** The part of a connection pool the sink uses, so a test can stand in for it. */
export interface AuditPool {
  query(text: string, values: readonly unknown[]): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'error', listener: () => void): unknown;
}

export interface AuditSinkDeps {
  readonly createPool: (config: pg.PoolConfig) => AuditPool;
}

const defaultDeps: AuditSinkDeps = { createPool: (config) => new pg.Pool(config) };

function valuesOf(event: AuditEvent, context: AuditSinkContext, detail: string | null): readonly unknown[] {
  return [
    context.newId(),
    event.actorId === SYSTEM_ACTOR ? SYSTEM_ACTOR_ID : event.actorId,
    event.actorRole ?? SYSTEM_ACTOR,
    event.action,
    event.result,
    event.sourceId ?? null,
    event.investigationId ?? null,
    event.resourceType ?? null,
    event.resourceRef ?? null,
    event.traceId,
    detail,
  ];
}

/** Records audit events in `audit_events` through the application's own database login; it reads no source and logs nothing. */
export function createAuditSink(context: AuditSinkContext, deps: AuditSinkDeps = defaultDeps): MountedAuditSink {
  const pool = deps.createPool({
    connectionString: context.databaseUrl,
    max: context.poolSize,
    ...(context.connectionStream === undefined ? {} : { stream: context.connectionStream }),
    connectionTimeoutMillis: context.connectionTimeoutMs,
    statement_timeout: context.statementTimeoutMs,
    query_timeout: context.queryTimeoutMs,
  });
  pool.on('error', context.onConnectionError);
  let closing: Promise<void> | undefined;

  return {
    sink: {
      async record(event) {
        let detail: string | null = null;
        if (event.detail !== undefined) {
          const parsed = auditDetailSchema.safeParse(event.detail);
          if (!parsed.success) throw new AuditSinkError('AUDIT_DETAIL_REFUSED');
          detail = JSON.stringify(parsed.data);
        }
        try {
          await pool.query(INSERT, valuesOf(event, context, detail));
        } catch {
          // the driver's error can hold the failing row, so only a fixed code leaves the sink
          throw new AuditSinkError('AUDIT_WRITE_FAILED');
        }
      },
    },
    close: () => (closing ??= pool.end()),
  };
}
