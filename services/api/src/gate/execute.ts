import { AppError } from '../errors.js';
import type { Coordinator, ReadLease } from '../seams/seams.js';
import { exhaustive } from './exhaustive.js';
import type { ReadExecutor } from './executor.js';
import type { Rendered } from './render.js';
import type { Clock, GateContext, GateLogger, Plan, Row, Template } from './types.js';

export interface ExecuteDeps {
  readonly coordinator: Coordinator;
  readonly executor: ReadExecutor;
  readonly clock: Clock;
  readonly logger: GateLogger;
}

export interface ExecuteResult {
  readonly rows: readonly Row[];
  readonly hasMore: boolean;
  /** The plan of a profiled read; absent for a read that is not profiled. */
  readonly plan?: Plan;
}

async function releaseLease(lease: ReadLease, logger: GateLogger): Promise<void> {
  try {
    await lease.release();
  } catch {
    // a lease that cannot be released expires on its own; the read's outcome must not change
    logger.warn({ event: 'gate.lease_release_failed' }, 'gate lease release failed');
  }
}

/** The timeout is the source's server-side transaction timeout, which is what the person is told; it holds no address, query or value. */
const timedOut = (context: GateContext): AppError => new AppError('QUERY_TIMEOUT', { timeoutMs: context.budgets.timeoutMs });

export async function executeRead(
  deps: ExecuteDeps,
  context: GateContext,
  template: Template,
  rendered: Rendered,
  limit: number,
): Promise<ExecuteResult> {
  if (deps.clock() >= context.deadlineAt) throw timedOut(context);
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
    if (deps.clock() >= context.deadlineAt) throw timedOut(context);
    outcome = await deps.executor.execute({
      sourceId: context.sourceId,
      templateId: template.id,
      templateVersion: template.version,
      cypher: rendered.cypher,
      parameters: rendered.parameters,
      integerParameters: template.integerParameters,
      ...(template.profile === true ? { profile: true } : {}),
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
      throw timedOut(context);
    case 'unavailable':
      throw new AppError('SOURCE_UNAVAILABLE', undefined, outcome.reason);
    case 'rows':
      return { rows: outcome.rows.slice(0, limit), hasMore: outcome.rows.length > limit, ...(template.profile === true ? { plan: outcome.plan ?? null } : {}) };
    default:
      return exhaustive(outcome);
  }
}
