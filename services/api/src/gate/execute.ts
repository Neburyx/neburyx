import { AppError, RequestCancelled } from '../errors.js';
import type { Coordinator, ReadLease, ReadOutcome } from '../seams/seams.js';
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

async function releaseLease(lease: ReadLease, logger: GateLogger, outcome?: ReadOutcome): Promise<void> {
  try {
    await lease.release(outcome);
  } catch {
    // a lease that cannot be released expires on its own; the read's outcome must not change
    logger.warn({ event: 'gate.lease_release_failed' }, 'gate lease release failed');
  }
}

/** Read afresh at each use: a signal can abort between two awaits. */
const cancelled = (context: GateContext): boolean => context.signal?.aborted === true;

/**
 * The limit the person is told is the one that stopped the read: the source's server-side transaction timeout, or the request's deadline when that was nearer (the deadline passed before the read could start,
 * or the read was given less time than the source's timeout because of it). It holds no address, query or value.
 */
const timedOut = (context: GateContext, byDeadline = false): AppError =>
  new AppError('QUERY_TIMEOUT', { timeoutMs: byDeadline ? context.budgets.requestTimeoutMs : context.budgets.timeoutMs });

/**
 * The lease of a read: granted by the coordinator within the source's slot limits, or the failure the person is told (the source is busy, or unavailable). The wait never runs past the
 * request's deadline. A lease lives at most the time left to the deadline, which bounds the read, plus the source's timeout, the longest the adapter waits for a session to close.
 * A read of the system runner is held by the source limit alone, so that the one system principal is not a funnel for every person's schema read.
 */
export async function acquireLease(deps: Pick<ExecuteDeps, 'coordinator' | 'clock' | 'logger'>, context: GateContext): Promise<ReadLease> {
  const left = context.deadlineAt - deps.clock();
  if (cancelled(context)) throw new RequestCancelled();
  if (left <= 0) throw timedOut(context, true);
  const { userConcurrency, sourceConcurrency, queueWaitMs, timeoutMs } = context.budgets;
  const admission = await deps.coordinator.acquireRead({
    principal: context.principal,
    sourceId: context.sourceId,
    limits: { userConcurrency: context.system ? sourceConcurrency : userConcurrency, sourceConcurrency, queueWaitMs: Math.min(queueWaitMs, left) },
    role: context.role,
    breaker: context.budgets.breaker,
    leaseTtlMs: left + timeoutMs,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  switch (admission.status) {
    case 'busy':
      throw new AppError('SOURCE_BUSY');
    case 'unavailable':
      throw new AppError('SOURCE_UNAVAILABLE', admission.retryAfterMs === undefined ? undefined : { retryAfterMs: admission.retryAfterMs }, admission.reason);
    case 'cancelled':
      throw new RequestCancelled();
    case 'granted':
      // a grant that lands in the abort's tick is given back here, once, and the read never starts
      if (cancelled(context)) {
        await releaseLease(admission.lease, deps.logger);
        throw new RequestCancelled();
      }
      return admission.lease;
    default:
      return exhaustive(admission);
  }
}

/** A lease that several reads share, and the promises of their connections coming back, which its owner waits for before it releases the lease. */
export interface SharedLease {
  readonly lease: ReadLease;
  readonly closings: Promise<void>[];
  /** What the circuit breaker is told when the lease is released: the worst end of the reads under it (timeout, then other, then answered); none yet counts as other. */
  outcome?: ReadOutcome;
}

const WORSE: Readonly<Record<ReadOutcome, number>> = { answered: 0, other: 1, timeout: 2 };

/**
 * How a read ended for the circuit breaker. A timeout counts only when the source was given a real chance: the read ran with at least the lesser of the source's timeout and what the request
 * deadline leaves after the longest queue wait. A stop by a deadline nearer than that says nothing about the source.
 */
function outcomeOf(outcome: ExecuteOutcome, context: GateContext, startedAt: number): ReadOutcome {
  if (outcome.status === 'rows') return 'answered';
  if (outcome.status !== 'timeout') return 'other';
  const { timeoutMs, requestTimeoutMs, queueWaitMs } = context.budgets;
  return context.deadlineAt - startedAt >= Math.min(timeoutMs, requestTimeoutMs - queueWaitMs) ? 'timeout' : 'other';
}

/** Releases a lease once every read under it has its connection back; the answer is not held up by it. */
export async function releaseWhenClosed(lease: ReadLease, closings: readonly Promise<void>[], logger: GateLogger, outcome: ReadOutcome = 'other'): Promise<void> {
  if (closings.length === 0) {
    await releaseLease(lease, logger, outcome);
    return;
  }
  void Promise.all(closings).then(() => releaseLease(lease, logger, outcome));
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
  let startedAt: number;
  let ended: ReadOutcome = 'other';
  try {
    if (cancelled(context)) throw new RequestCancelled();
    startedAt = deps.clock();
    if (startedAt >= context.deadlineAt) throw timedOut(context, true);
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
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      onClosed: (given) => {
        closed = given;
      },
    });
    ended = outcomeOf(outcome, context, startedAt);
  } finally {
    // the lease is kept until the read's connection is back, without holding up the answer
    if (shared !== undefined) {
      if (closed !== undefined) shared.closings.push(closed);
      shared.outcome = shared.outcome === undefined || WORSE[ended] > WORSE[shared.outcome] ? ended : shared.outcome;
    } else await releaseWhenClosed(lease, closed === undefined ? [] : [closed], deps.logger, ended);
  }
  switch (outcome.status) {
    case 'timeout':
      // the adapter gives the read the lesser of the source's timeout and the time left to the deadline, so a read started with less left than the timeout was stopped by the deadline
      throw timedOut(context, context.deadlineAt - startedAt < context.budgets.timeoutMs);
    case 'cancelled':
      throw new RequestCancelled();
    case 'unavailable':
      throw new AppError('SOURCE_UNAVAILABLE', undefined, outcome.reason);
    case 'rows':
      return { rows: outcome.rows.slice(0, limit), hasMore: outcome.rows.length > limit, ...(template.profile === true ? { plan: outcome.plan ?? null } : {}) };
    default:
      return exhaustive(outcome);
  }
}
