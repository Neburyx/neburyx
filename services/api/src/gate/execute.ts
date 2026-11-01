import { AppError } from '../errors.js';
import type { Coordinator, ReadLease } from '../seams/seams.js';
import { exhaustive } from './exhaustive.js';
import type { Clock, GateContext, GateLogger, Params, ReadExecutor, Row, Template } from './types.js';

export interface ExecuteDeps {
  readonly coordinator: Coordinator;
  readonly executor: ReadExecutor;
  readonly clock: Clock;
  readonly logger: GateLogger;
}

export interface ExecuteResult {
  readonly rows: readonly Row[];
  readonly hasMore: boolean;
}

async function releaseLease(lease: ReadLease, logger: GateLogger): Promise<void> {
  try {
    await lease.release();
  } catch {
    // a lease that cannot be released expires on its own; the read's outcome must not change
    logger.warn({ event: 'gate.lease_release_failed' }, 'gate lease release failed');
  }
}

export async function executeRead(
  deps: ExecuteDeps,
  context: GateContext,
  template: Template,
  params: Params,
  limit: number,
): Promise<ExecuteResult> {
  if (deps.clock() >= context.deadlineAt) throw new AppError('QUERY_TIMEOUT');
  const admission = await deps.coordinator.acquireRead({ principal: context.principal, sourceId: context.sourceId });
  switch (admission.status) {
    case 'busy':
      throw new AppError('SOURCE_BUSY');
    case 'unavailable':
      throw new AppError('SOURCE_UNAVAILABLE');
    case 'granted':
      break;
    default:
      return exhaustive(admission);
  }
  let outcome;
  try {
    if (deps.clock() >= context.deadlineAt) throw new AppError('QUERY_TIMEOUT');
    outcome = await deps.executor.execute({
      sourceId: context.sourceId,
      templateId: template.id,
      templateVersion: template.version,
      cypher: template.cypher,
      parameters: params,
      accessMode: 'READ',
      timeoutMs: context.budgets.timeoutMs,
      rowLimit: limit + 1,
      deadlineAt: context.deadlineAt,
      traceId: context.traceId,
    });
  } finally {
    await releaseLease(admission.lease, deps.logger);
  }
  switch (outcome.status) {
    case 'timeout':
      throw new AppError('QUERY_TIMEOUT');
    case 'unavailable':
      throw new AppError('SOURCE_UNAVAILABLE');
    case 'rows':
      return { rows: outcome.rows.slice(0, limit), hasMore: outcome.rows.length > limit };
    default:
      return exhaustive(outcome);
  }
}
