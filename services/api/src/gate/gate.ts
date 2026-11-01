import { AppError } from '../errors.js';
import type { AuditEvent } from '../seams/seams.js';
import { auditResultFor, FALLBACK_AUDIT_ACTION } from './audit.js';
import { authorizeRequest } from './authorize.js';
import { executeRead } from './execute.js';
import { exhaustive } from './exhaustive.js';
import type { Gate, GateContext, GateDeps, GatePage, GateRequest, GateStage } from './types.js';
import { findTemplate, validateRequest } from './validate.js';

interface Progress {
  stage: GateStage;
  action: string;
}

async function inStage<T>(deps: GateDeps, progress: Progress, stage: GateStage, work: () => T | Promise<T>): Promise<T> {
  progress.stage = stage;
  try {
    const value = await work();
    deps.observer?.stage(stage, 'ok');
    return value;
  } catch (error) {
    deps.observer?.stage(stage, 'failed');
    throw error;
  }
}

function resolveContext(deps: GateDeps, request: GateRequest): GateContext {
  const budgets = deps.budgetsFor(request.sourceId);
  return {
    traceId: request.traceId,
    principal: request.principal,
    sourceId: request.sourceId,
    budgets,
    deadlineAt: deps.clock() + budgets.requestTimeoutMs,
  };
}

async function runStages(deps: GateDeps, request: GateRequest, progress: Progress): Promise<GatePage> {
  const context = await inStage(deps, progress, 'resolve', () => resolveContext(deps, request));
  const { template, params } = await inStage(deps, progress, 'validate', () => {
    const found = findTemplate(deps.catalog, request);
    progress.action = found.auditAction;
    return validateRequest(deps.catalog, found, request, context);
  });
  await inStage(deps, progress, 'authorize', () => authorizeRequest(deps.seams.policy, context));
  const result = await inStage(deps, progress, 'execute', () =>
    executeRead({ coordinator: deps.seams.coordinator, executor: deps.executor, clock: deps.clock, logger: deps.logger }, context, template, params, request.limit),
  );
  const items = await inStage(deps, progress, 'normalize', () => template.normalize(result.rows));
  const redacted = await inStage(deps, progress, 'redact', () => deps.redact(items, context));
  return { items: redacted, hasMore: result.hasMore };
}

async function recordAudit(deps: GateDeps, request: GateRequest, progress: Progress, failure: AppError | undefined): Promise<void> {
  const event: AuditEvent = {
    actorId: request.principal.id,
    actorRole: request.principal.role,
    action: progress.action,
    result: auditResultFor(failure),
    sourceId: request.sourceId,
    traceId: request.traceId,
  };
  try {
    await deps.seams.audit.record(event);
    deps.observer?.stage('audit', 'ok');
  } catch {
    // the response does not depend on the audit write for a read; the log line carries no event data
    deps.observer?.stage('audit', 'failed');
    deps.logger.warn({ event: 'gate.audit_failed' }, 'gate audit write failed');
  }
}

function asAppError(deps: GateDeps, error: unknown, stage: GateStage): AppError {
  if (error instanceof AppError) return error;
  deps.logger.warn({ event: 'gate.internal_error', stage }, 'gate stage failed unexpectedly');
  return new AppError('INTERNAL_ERROR');
}

type Attempt = { readonly status: 'page'; readonly page: GatePage } | { readonly status: 'failure'; readonly failure: AppError };

async function attempt(deps: GateDeps, request: GateRequest, progress: Progress): Promise<Attempt> {
  try {
    return { status: 'page', page: await runStages(deps, request, progress) };
  } catch (error) {
    return { status: 'failure', failure: asAppError(deps, error, progress.stage) };
  }
}

export function createGate(deps: GateDeps): Gate {
  return {
    async run(request) {
      const progress: Progress = { stage: 'resolve', action: FALLBACK_AUDIT_ACTION };
      const outcome = await attempt(deps, request, progress);
      switch (outcome.status) {
        case 'page':
          await recordAudit(deps, request, progress, undefined);
          return outcome.page;
        case 'failure':
          await recordAudit(deps, request, progress, outcome.failure);
          throw outcome.failure;
        default:
          return exhaustive(outcome);
      }
    },
  };
}
