import { AppError } from '../errors.js';
import type { Coordinator, ReadLease } from '../seams/seams.js';
import { exhaustive } from './exhaustive.js';
import type { ExecuteOutcome, ReadExecutor } from './executor.js';
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

/**
 * The lease of a read: granted by the coordinator within the source's slot limits, or the failure the person is told (the source is busy, or unavailable). The wait never runs past the
 * request's deadline. A lease lives at most the time left to the deadline, which bounds the read, plus the source's timeout, the longest the adapter waits for a session to close.
 * A read of the system runner is held by the source limit alone, so that the one system principal is not a funnel for every person's schema read.
 */
export async function acquireLease(deps: Pick<ExecuteDeps, 'coordinator' | 'clock'>, context: GateContext): Promise<ReadLease> {
  const left = context.deadlineAt - deps.clock();
  if (left <= 0) throw timedOut(context);
  const { userConcurrency, sourceConcurrency, queueWaitMs, timeoutMs } = context.budgets;
  const admission = await deps.coordinator.acquireRead({
    principal: context.principal,
    sourceId: context.sourceId,
    limits: { userConcurrency: context.system ? sourceConcurrency : userConcurrency, sourceConcurrency, queueWaitMs: Math.min(queueWaitMs, left) },
    leaseTtlMs: left + timeoutMs,
  });
  switch (admission.status) {
    case 'busy':
      throw new AppError('SOURCE_BUSY');
    case 'unavailable':
      throw new AppError('SOURCE_UNAVAILABLE');
    case 'granted':
      return admission.lease;
    default:
      return exhaustive(admission);
  }
}

/** A lease that several reads share, and the promises of their connections coming back, which its owner waits for before it releases the lease. */
export interface SharedLease {
  readonly lease: ReadLease;
  readonly closings: Promise<void>[];
}

/** Releases a lease once every read under it has its connection back; the answer is not held up by it. */
export async function releaseWhenClosed(lease: ReadLease, closings: readonly Promise<void>[], logger: GateLogger): Promise<void> {
  if (closings.length === 0) {
    await releaseLease(lease, logger);
    return;
  }
  void Promise.all(closings).then(() => releaseLease(lease, logger));
}

/** Runs one read. Without a lease it takes and releases its own; with a shared one (a request that reads several pages under one lease) it uses it and hands its connection's return to the owner. */
export async function executeRead(
  deps: ExecuteDeps,
  context: GateContext,
  template: Template,
  rendered: Rendered,
  limit: number,
  shared?: SharedLease,
): Promise<ExecuteResult> {
  const lease = shared?.lease ?? (await acquireLease(deps, context));
  let closed: Promise<void> | undefined;
  let outcome: ExecuteOutcome;
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
      onClosed: (given) => {
        closed = given;
      },
    });
  } finally {
    // the lease is kept until the read's connection is back, without holding up the answer
    if (shared !== undefined) {
      if (closed !== undefined) shared.closings.push(closed);
    } else await releaseWhenClosed(lease, closed === undefined ? [] : [closed], deps.logger);
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
