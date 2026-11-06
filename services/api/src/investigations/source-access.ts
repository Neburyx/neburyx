import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../errors.js';
import { entityLoadTemplate } from '../gate/templates/entity-load.js';
import type { MappingModel } from '../mapping/model.js';
import type { Principal, Seams } from '../seams/seams.js';

const ENTITY_LOAD_AUDIT_ACTION = entityLoadTemplate.auditAction;

export interface SourceAccessCall {
  readonly traceId: string;
  readonly principal: Principal;
  readonly sourceId: string;
  /** The audit action of the denied event: the entity read's unless the caller names its own (a search). */
  readonly auditAction?: string;
}

/** Whether the person may read a source, asked before anything else about it is looked at. A source that is not configured and one the person may not read answer the same `NOT_FOUND`, so a link never tells them apart. The gate still authorizes the read. */
export interface SourceAccess {
  require(call: SourceAccessCall): Promise<void>;
}

export function createSourceAccess(deps: { readonly mapping: MappingModel; readonly seams: Pick<Seams, 'policy' | 'audit'>; readonly logger: Pick<FastifyBaseLogger, 'warn'> }): SourceAccess {
  async function recordDenied(call: SourceAccessCall, configured: boolean): Promise<void> {
    try {
      await deps.seams.audit.record({ actorId: call.principal.id, actorRole: call.principal.role, action: call.auditAction ?? ENTITY_LOAD_AUDIT_ACTION, result: 'denied', ...(configured ? { sourceId: call.sourceId } : {}), traceId: call.traceId });
    } catch {
      // the answer does not depend on the audit write, as for a read through the gate; the log line carries no event data
      deps.logger.warn({ event: 'source_access.audit_failed' }, 'audit write failed');
    }
  }

  return {
    async require(call) {
      const configured = deps.mapping.sources.some((source) => source.id === call.sourceId);
      const decision = configured ? await deps.seams.policy.authorizeSource({ principal: call.principal, sourceId: call.sourceId }) : undefined;
      if (decision?.allowed === true) return;
      await recordDenied(call, configured);
      throw new AppError('NOT_FOUND');
    },
  };
}
