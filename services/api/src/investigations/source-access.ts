import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../errors.js';
import { entityLoadTemplate } from '../gate/templates/entity-load.js';
import type { MappingModel } from '../mapping/model.js';
import type { RequestLimiter } from '../rate/request-limiter.js';
import type { Principal, Seams } from '../seams/seams.js';

const ENTITY_LOAD_AUDIT_ACTION = entityLoadTemplate.auditAction;

export interface SourceAccessCall {
  readonly traceId: string;
  readonly principal: Principal;
  readonly sourceId: string;
  /** The audit action of the denied event: the entity read's unless the caller names its own (a search). */
  readonly auditAction?: string;
  /** Counts the call as one request once the person may read the source: the shorthand for `require`, then `admit`. Only the call that is the request's own sets it. */
  readonly rate?: 'count';
}

/** Whether the person may read a source, asked before anything else about it is looked at. A source that is not configured and one the person may not read answer the same `NOT_FOUND`, so a link never tells them apart. The gate still authorizes the read. */
export interface SourceAccess {
  require(call: SourceAccessCall): Promise<void>;
  /** Counts one request of the person on the source against its rate, or throws `RATE_LIMITED`. Asked after `require`, so a source the person may not read never answers it. */
  admit(call: { readonly traceId: string; readonly principal: Principal; readonly sourceId: string }): void;
  /** A source no longer in the configuration is kept: it is the person's own work and the policy cannot be asked about it. Nothing is audited, because nothing was read. */
  readable(call: { readonly principal: Principal; readonly sourceIds: readonly string[] }): Promise<string[]>;
}

export function createSourceAccess(deps: { readonly mapping: MappingModel; readonly seams: Pick<Seams, 'policy' | 'audit'>; readonly logger: Pick<FastifyBaseLogger, 'warn'> & Partial<Pick<FastifyBaseLogger, 'info'>>; readonly limiter?: RequestLimiter }): SourceAccess {
  async function recordDenied(call: SourceAccessCall, configured: boolean): Promise<void> {
    try {
      await deps.seams.audit.record({ actorId: call.principal.id, actorRole: call.principal.role, action: call.auditAction ?? ENTITY_LOAD_AUDIT_ACTION, result: 'denied', ...(configured ? { sourceId: call.sourceId } : {}), traceId: call.traceId });
    } catch {
      // the answer does not depend on the audit write, as for a read through the gate; the log line carries no event data
      deps.logger.warn({ event: 'source_access.audit_failed' }, 'audit write failed');
    }
  }

  function admit(call: { readonly traceId: string; readonly principal: Principal; readonly sourceId: string }): void {
    if (deps.limiter === undefined) return;
    const source = deps.mapping.sources.find((candidate) => candidate.id === call.sourceId);
    if (source === undefined) return;
    try {
      deps.limiter.admit({ sourceId: call.sourceId, principalId: call.principal.id }, source.budgets.requestsPerMinute);
    } catch (error) {
      if (error instanceof AppError && error.code === 'RATE_LIMITED') {
        const { retryAfterMs } = error.details as { retryAfterMs: number };
        deps.logger.info?.({ event: 'request.rate_limited', traceId: call.traceId, sourceId: call.sourceId, retryAfterMs }, 'request rate limited');
      }
      throw error;
    }
  }

  return {
    admit,
    async require(call) {
      const configured = deps.mapping.sources.some((source) => source.id === call.sourceId);
      const decision = configured ? await deps.seams.policy.authorizeSource({ principal: call.principal, sourceId: call.sourceId }) : undefined;
      if (decision?.allowed === true) {
        if (call.rate === 'count') admit(call);
        return;
      }
      await recordDenied(call, configured);
      throw new AppError('NOT_FOUND');
    },
    async readable(call) {
      const decided = await Promise.all(
        call.sourceIds.map(async (sourceId) => {
          if (!deps.mapping.sources.some((source) => source.id === sourceId)) return true;
          return (await deps.seams.policy.authorizeSource({ principal: call.principal, sourceId })).allowed;
        }),
      );
      return call.sourceIds.filter((_sourceId, index) => decided[index] === true);
    },
  };
}
