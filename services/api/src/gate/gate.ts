import { AppError } from '../errors.js';
import { makeToken } from '../reference/token.js';
import { mapPositionReferences } from './cursor/references.js';
import { AdapterError } from '../sources/errors.js';
import type { AuditEvent } from '../seams/seams.js';
import { auditResultFor, FALLBACK_AUDIT_ACTION } from './audit.js';
import { authorizeRequest } from './authorize.js';
import { executeRead, type ExecuteResult } from './execute.js';
import { isMet, readIndexSnapshot } from './index-guard.js';
import { exhaustive } from './exhaustive.js';
import type { GateDeps } from './deps.js';
import { SYSTEM_PRINCIPAL } from './system-principal.js';
import type { Gate, GateContext, IndexReader, GatePage, GateRequest, GateStage, Params, SystemRunner, Template } from './types.js';
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

function resolveContext(deps: GateDeps, request: GateRequest, system: boolean): GateContext {
  const budgets = deps.budgetsFor(request.sourceId);
  return {
    traceId: request.traceId,
    principal: request.principal,
    system,
    sourceId: request.sourceId,
    budgets,
    allowlist: deps.allowlistFor(request.sourceId),
    policyVersion: deps.policyVersion(request.sourceId),
    mask: !system && request.mask === true,
    model: deps.modelFor(request.sourceId),
    deadlineAt: deps.clock() + budgets.requestTimeoutMs,
  };
}

/** Finds out, before the data read, that the indexes a template needs are online: from the snapshot the caller gave or from one fresh read of the schema; a refusal when one is not. */
async function guardIndexes(deps: GateDeps, request: GateRequest, context: GateContext, template: Template, params: Params): Promise<void> {
  const needs = template.indexNeeds?.(params, context.allowlist) ?? [];
  if (needs.length === 0) return;
  if (request.indexes === 'unverified') return;
  if (request.indexes !== undefined && 'failure' in request.indexes) throw request.indexes.failure;
  const given = request.indexes !== undefined && request.indexes.sourceId === request.sourceId ? request.indexes : undefined;
  const snapshot = given ?? (await readIndexSnapshot((read) => runGate(deps, { ...read, principal: SYSTEM_PRINCIPAL }, true), { traceId: request.traceId, sourceId: request.sourceId }));
  if (snapshot === 'unverified') return;
  if (needs.some((need) => !isMet(snapshot, need, context.allowlist))) throw new AppError('SOURCE_UNAVAILABLE', undefined, 'index-unavailable');
}

async function runStages(deps: GateDeps, request: GateRequest, system: boolean, progress: Progress): Promise<GatePage> {
  const context = await inStage(deps, progress, 'resolve', () => resolveContext(deps, request, system));
  const { template, params, rendered, binding } = await inStage(deps, progress, 'validate', () => {
    const found = findTemplate(deps.catalog, request);
    progress.action = found.auditAction;
    return validateRequest(deps.catalog, found, request, context, deps.cursors, deps.references);
  });
  await inStage(deps, progress, 'authorize', () => authorizeRequest(deps.seams.policy, deps.usability, context, template));
  const result = await inStage(deps, progress, 'execute', async (): Promise<ExecuteResult> => {
    if (template.readsNothing?.(params, context.allowlist) === true) return { rows: [], hasMore: false };
    if (!system) await guardIndexes(deps, request, context, template, params);
    return executeRead({ coordinator: deps.seams.coordinator, executor: deps.executor, clock: deps.clock, logger: deps.logger }, context, template, rendered, request.limit);
  });
  const normalized = await inStage(deps, progress, 'normalize', () => {
    const items = template.normalize(result.rows, result.plan, { sourceId: context.sourceId, hasMore: result.hasMore, model: context.model, limit: request.limit, countCap: context.budgets.countCap, params, references: deps.references });
    // the page after this one, when there is one: the template says where it starts and the gate signs it for this request
    const position = template.paged && result.hasMore ? template.nextPosition?.(result.rows, request.limit) : undefined;
    return { items, nextCursor: position === undefined ? undefined : deps.cursors.mint(binding, mapPositionReferences(template, position, context, (entityType, stableId) => makeToken(deps.references, { sourceId: context.sourceId, entityType }, stableId))) };
  });
  const redacted = await inStage(deps, progress, 'redact', () => deps.redact(normalized.items, context));
  return { items: redacted, hasMore: result.hasMore, ...(normalized.nextCursor === undefined ? {} : { nextCursor: normalized.nextCursor }) };
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
  // the tag tells a read the adapter could not run (already logged with the server code) from any other internal failure
  return error instanceof AdapterError && error.code === 'READ_FAILED' && stage === 'execute' ? new AppError('INTERNAL_ERROR', undefined, 'read-failed') : new AppError('INTERNAL_ERROR');
}

type Attempt = { readonly status: 'page'; readonly page: GatePage } | { readonly status: 'failure'; readonly failure: AppError };

async function attempt(deps: GateDeps, request: GateRequest, system: boolean, progress: Progress): Promise<Attempt> {
  try {
    return { status: 'page', page: await runStages(deps, request, system, progress) };
  } catch (error) {
    return { status: 'failure', failure: asAppError(deps, error, progress.stage) };
  }
}

async function runGate(deps: GateDeps, request: GateRequest, system: boolean): Promise<GatePage> {
  const progress: Progress = { stage: 'resolve', action: FALLBACK_AUDIT_ACTION };
  const outcome = await attempt(deps, request, system, progress);
  // decided from the catalog entry of the requested template, so it holds whatever stage the run fails in
  const audited = !(system && deps.catalog.find(request.templateId)?.auditSystemRuns === false);
  switch (outcome.status) {
    case 'page':
      if (audited) await recordAudit(deps, request, progress, undefined);
      return outcome.page;
    case 'failure':
      if (audited) await recordAudit(deps, request, progress, outcome.failure);
      throw outcome.failure;
    default:
      return exhaustive(outcome);
  }
}

export function createGates(deps: GateDeps): { readonly gate: Gate; readonly system: SystemRunner; readonly indexes: IndexReader } {
  return {
    gate: { run: (request) => runGate(deps, request, false) },
    indexes: {
      async read(request) {
        const decision = await deps.seams.policy.authorizeSource({ principal: request.principal, sourceId: request.sourceId });
        if (!decision.allowed || !deps.usability.isUsable(request.sourceId)) return 'unverified';
        return readIndexSnapshot((read) => runGate(deps, { ...read, principal: SYSTEM_PRINCIPAL }, true), request);
      },
    },
    system: {
      run: (request) =>
        runGate(deps, { traceId: request.traceId, principal: SYSTEM_PRINCIPAL, sourceId: request.sourceId, templateId: request.templateId, params: request.params, limit: request.limit }, true),
    },
  };
}

export function createGate(deps: GateDeps): Gate {
  return createGates(deps).gate;
}
