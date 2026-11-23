import { ASSISTANT_CONFIRMATION_INVALID_SENTENCE, type AssistantTurnAnswer, type AssistantTurnRequest, type ExtensionRequest } from '@neburyx/contracts';
import { ASK_CONTINUE_LIFETIME_MS } from '@neburyx/contracts';
import type { LoopOutcome, ResumeState } from './turn-outcome.js';
import { newPendingId, type AssistantPendingStore, type ClaimResult } from './pending-store.js';
import { hashKeys, hashText, issuePlan, readPlan, type Plan, type PlanBinding } from './plan-token.js';
import { heavyOf, subjectOf } from './reads.js';
import { currentRunId } from './turn-audit.js';

export const CONFIRMATION_ACTION = 'assistant.confirmation';

/** What happened to a waiting confirmation, as the audit event names it: shown, decided (confirm, skip, cancel), replaced by a new message or a new confirmation, expired when found, or a decision that was refused. */
export type ConfirmationEvent = 'shown' | 'confirm' | 'skip' | 'cancel' | 'replaced' | 'expired' | 'invalid';

const labelOf = (text: string): string => text.replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, 100) || 'unknown';

/** One event of the waiting state: the tool where it is known, the cause of a refusal, never a value; the record of the turn is the run it belongs to. */
export async function auditConfirmation(request: ExtensionRequest, ids: { readonly sourceId: string; readonly investigationId: string }, event: ConfirmationEvent, detail: { readonly tool?: string; readonly cause?: string } = {}): Promise<void> {
  const runId = currentRunId();
  await request.audit
    .record({
      actorId: request.principalId,
      actorRole: request.principalRole,
      action: CONFIRMATION_ACTION,
      result: event === 'invalid' ? 'refused' : 'success',
      sourceId: ids.sourceId,
      investigationId: ids.investigationId,
      traceId: request.traceId,
      detail: { turn: { route: 'ask', outcome: 'confirmation', cause: labelOf(event === 'invalid' ? `invalid-${detail.cause ?? 'unknown'}` : event), ...(detail.tool === undefined ? {} : { intent: labelOf(detail.tool) }), modelCalls: 0, ...(runId === undefined ? {} : { runId }) } },
    })
    .catch(() => undefined);
}

type Waiting = Extract<LoopOutcome, { kind: 'waiting' }>;

export interface WaitContext {
  /** The form of the answer the router chose, kept in the plan so that the resumed turn answers in it. */
  readonly form?: 'table';
  readonly request: ExtensionRequest;
  readonly sourceId: string;
  readonly investigationId: string;
  readonly mask: boolean;
  readonly message: string;
  readonly viewElementKeys: readonly string[];
  readonly startedAt: number;
  readonly now: () => number;
  readonly store: AssistantPendingStore;
  /** The fingerprint of the definition of a tool, as the continue of Ask binds it; absent when the tool is not found. */
  readonly definitionOf: (tool: string, values: Readonly<Record<string, string>>) => Promise<string | undefined>;
}

const UNAVAILABLE: AssistantTurnAnswer = { status: 'unavailable', kind: 'service', readStarted: true };

/**
 * The turn reached a heavy step after at least one read: nothing of the step is read. The plan that carries the turn on is signed and given to the panel, and a small row makes it single-use; the answer says what the step would read.
 * When the plan cannot be made or the store cannot be reached, the step is not run and the turn is unavailable: nothing waits that cannot be decided.
 */
export async function waitingAnswer(ctx: WaitContext, outcome: Waiting): Promise<AssistantTurnAnswer> {
  const { request, wait } = { request: ctx.request, wait: outcome.wait };
  const definition = await ctx.definitionOf(wait.request.tool.name, wait.request.values);
  const sign = request.signText;
  const heavy = heavyOf(wait.answer.result);
  if (definition === undefined || sign === undefined || heavy === undefined) return UNAVAILABLE;
  const now = ctx.now();
  const binding: PlanBinding = { principalId: request.principalId, sourceId: ctx.sourceId, investigationId: ctx.investigationId, definition, mask: ctx.mask };
  const runId = currentRunId();
  const plan = issuePlan(
    sign,
    binding,
    {
      messageHash: hashText(ctx.message),
      viewHash: hashKeys(ctx.viewElementKeys),
      fromView: outcome.fromView,
      ...(ctx.form === undefined ? {} : { form: ctx.form }),
      steps: [...outcome.steps],
      wait: { tool: wait.request.tool.name, values: { ...wait.request.values } },
      counters: { ...outcome.counters, elapsedMs: Math.max(0, now - ctx.startedAt) },
      ...(runId === undefined ? {} : { runId }),
    },
    now,
  );
  if (plan === undefined) return UNAVAILABLE;
  const pendingId = newPendingId();
  try {
    const { replaced } = await ctx.store.add({ id: pendingId, userId: request.principalId, investigationId: ctx.investigationId, sourceId: ctx.sourceId, mask: ctx.mask, expiresAtMs: now + ASK_CONTINUE_LIFETIME_MS }, now);
    // the event names where the dropped confirmation was waiting, and no tool: the row does not hold one
    if (replaced !== undefined) await auditConfirmation(request, replaced, 'replaced');
  } catch {
    return UNAVAILABLE;
  }
  await auditConfirmation(request, ctx, 'shown', { tool: wait.request.tool.name });
  const subject = subjectOf(wait.request.values);
  return {
    status: 'confirmation',
    pendingId,
    plan,
    step: { tool: wait.request.tool.name, ...(wait.request.tool.kind === 'intent' && wait.request.tool.label !== undefined ? { label: wait.request.tool.label } : {}), kind: wait.request.tool.kind, ...(subject === undefined ? {} : { subject }), count: { quality: 'lowerBound', value: heavy.value }, page: heavy.page },
    reads: [...outcome.reads],
  };
}

type Confirmation = Extract<AssistantTurnRequest, { confirmation: unknown }>;

export interface DecideContext {
  readonly request: ExtensionRequest;
  readonly sourceId: string;
  readonly investigationId: string;
  readonly mask: boolean;
  readonly now: () => number;
  readonly store: AssistantPendingStore;
  readonly definitionOf: (tool: string, values: Readonly<Record<string, string>>) => Promise<string | undefined>;
  /** Whether the tool the plan waits on is still one the turn may use (its template can run, its pattern is still there). */
  readonly toolAvailable: (tool: string) => boolean;
}

export type Decision =
  /** The decision was refused, or was a cancel: the answer to give. */
  | { readonly kind: 'answer'; readonly answer: AssistantTurnAnswer }
  /** The plan is verified and the confirmation claimed: the turn goes on from it. */
  | { readonly kind: 'resume'; readonly plan: Plan; readonly decision: 'confirm' | 'skip'; readonly resume: ResumeState };

/** Reads the tool a plan waits on without trusting it, only to find the definition the signature is bound to; the signature then decides whether the plan is the server's. */
function peekWaitTool(plan: string): string | undefined {
  try {
    const [, payload = ''] = plan.split('.');
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const wait = typeof parsed === 'object' && parsed !== null ? (parsed as { wait?: { tool?: unknown; values?: unknown } }).wait : undefined;
    return typeof wait?.tool === 'string' ? wait.tool : undefined;
  } catch {
    return undefined;
  }
}

const INVALID: AssistantTurnAnswer = { status: 'confirmation-invalid', sentence: ASSISTANT_CONFIRMATION_INVALID_SENTENCE };

/**
 * A decision on a waiting confirmation: the signed plan is verified against who sends it, the message as typed and the keys of the view it was made for, and the row is claimed, once. Anything else is the fixed sentence and nothing is read,
 * audited as `invalid` with its cause. A cancel ends the turn here; a confirm or a skip comes back to go on.
 */
export async function openDecision(ctx: DecideContext, body: { readonly message: string; readonly viewElementKeys: readonly string[]; readonly confirmation: Confirmation['confirmation'] }): Promise<Decision> {
  const { request } = ctx;
  const refuse = async (cause: string, tool?: string): Promise<Decision> => {
    await auditConfirmation(request, ctx, 'invalid', { cause, ...(tool === undefined ? {} : { tool }) });
    return { kind: 'answer', answer: INVALID };
  };
  const sign = request.signText;
  const tool = peekWaitTool(body.confirmation.plan);
  if (sign === undefined || tool === undefined) return refuse('plan');
  const now = ctx.now();
  // the values of the unverified plan are used only to name the definition; a plan whose values were changed fails the signature below
  const peeked = (() => {
    try {
      const [, payload = ''] = body.confirmation.plan.split('.');
      return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { wait?: { values?: Record<string, string> } }).wait?.values ?? {};
    } catch {
      return {};
    }
  })();
  const definition = await ctx.definitionOf(tool, peeked);
  if (definition === undefined) return refuse('plan');
  const plan = readPlan(sign, body.confirmation.plan, { principalId: request.principalId, sourceId: ctx.sourceId, investigationId: ctx.investigationId, definition, mask: ctx.mask }, now);
  if (plan === undefined) return refuse('plan', tool);
  // a cancel reads nothing, so it never needs the step: it is claimed and dropped as usual
  if (body.confirmation.decision !== 'cancel' && !ctx.toolAvailable(tool)) return refuse('step', tool);
  if (plan.messageHash !== hashText(body.message)) return refuse('message', tool);
  if (plan.viewHash !== hashKeys(body.viewElementKeys)) return refuse('view', tool);
  let claimed: ClaimResult;
  try {
    claimed = await ctx.store.claim(body.confirmation.pendingId, { userId: request.principalId, investigationId: ctx.investigationId, sourceId: ctx.sourceId, mask: ctx.mask }, now);
  } catch {
    return { kind: 'answer', answer: { status: 'unavailable', kind: 'service', readStarted: false } };
  }
  if (claimed !== 'claimed') {
    if (claimed === 'expired') await auditConfirmation(request, ctx, 'expired', { tool });
    return refuse(claimed, tool);
  }
  const { decision } = body.confirmation;
  if (decision === 'cancel') {
    await auditConfirmation(request, ctx, 'cancel', { tool });
    return { kind: 'answer', answer: { status: 'cancelled' } };
  }
  await auditConfirmation(request, ctx, decision, { tool });
  return { kind: 'resume', plan, decision, resume: { steps: plan.steps, wait: plan.wait, fromView: plan.fromView, decision, counters: { steps: plan.counters.steps, rows: plan.counters.rows, calls: plan.counters.calls } } };
}
