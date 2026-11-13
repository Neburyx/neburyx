import { ASK_PLAN_TEMPLATE_IDS, askRunRequestSchema, askRunResponseSchema, ExtensionRefusal, type AuditEvent, type ExtensionRefusalFields, type ExtensionRequest, type ExtensionRoute } from '@neburyx/contracts';
import { paramsHashOf } from '../plans/params-hash.js';
import type { PlanStore, RunOutcome, StoredPlan } from '../plans/index.js';
import { refusalOfPlan } from '../plans/refusals.js';
import { summarizeRun } from '../plans/run-summary.js';

export const ASK_RUN_URL = '/v1/ask/run';
/** The action of the audit event of a run of a plan. */
export const ASK_RUN_ACTION = 'ask.run';

export interface AskRunRouteOptions {
  /** The store of plans, asked each time because the application builds it after the route is made. */
  readonly plans?: () => PlanStore | undefined;
}

const unsupported = (): ExtensionRefusal => new ExtensionRefusal({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });

const RESULTS: Readonly<Record<RunOutcome, AuditEvent['result']>> = { complete: 'success', partial: 'partial', failed: 'failed' };

async function record(request: ExtensionRequest, plan: StoredPlan, outcome: RunOutcome, paramsHash: string, rowCount: number): Promise<void> {
  try {
    await request.audit.record({
      actorId: request.principalId,
      actorRole: request.principalRole,
      action: ASK_RUN_ACTION,
      result: RESULTS[outcome],
      sourceId: plan.sourceId,
      resourceType: 'ask-plan',
      resourceRef: plan.id,
      traceId: request.traceId,
      detail: { askRun: { templateId: plan.templateId, templateVersion: plan.templateVersion, paramsHash, rowCount } },
    });
  } catch {
    // the run and its record are written: only the event is missing, and a run that cannot be audited gives no result
    throw new ExtensionRefusal({ code: 'AUDIT_UNAVAILABLE' });
  }
}

/**
 * Runs a confirmed plan once. The call claims the plan (`confirmed`) before anything is read, so a plan runs for one call only; the run reads the plan's own source through the application's runner and
 * the gate; the plan becomes `run` and one run row is written in one transaction, after which one audit event is written. A read the gate refuses is a `failed` run and answers the gate's refusal.
 */
export function createAskRunRoute(options: AskRunRouteOptions = {}): ExtensionRoute {
  const plansOf = options.plans ?? (() => undefined);
  return {
    method: 'POST',
    url: ASK_RUN_URL,
    permission: 'principal',
    requestSchema: askRunRequestSchema,
    responseSchema: askRunResponseSchema,
    async handler(request) {
      if (!request.askPlanner.availability().available) throw unsupported();
      const plans = plansOf();
      const runnerFor = request.askPlanRunner;
      // a run that cannot be recorded, signed or read through the gate is refused before the plan is claimed
      if (plans === undefined || runnerFor === undefined || request.previewMac === undefined) throw unsupported();
      const body = askRunRequestSchema.parse(request.body);
      const claim = await plans.claim(body.planId, request.principalId);
      if (claim.status !== 'claimed') throw refusalOfPlan(claim.status);
      const plan = claim.plan;
      // the hash is of the parameters as the claim gave them, whatever the store keeps of them afterwards
      const paramsHash = paramsHashOf(request.previewMac, plan.params);
      const started = performance.now();
      let refusal: ExtensionRefusalFields | undefined;
      let failure: { readonly error: unknown } | undefined;
      let run: Awaited<ReturnType<ReturnType<typeof runnerFor>['run']>> | undefined;
      const templateId = ASK_PLAN_TEMPLATE_IDS.find((candidate) => candidate === plan.templateId);
      if (templateId === undefined) refusal = { code: 'ASK_PLAN_INVALID' };
      else {
        try {
          run = await runnerFor({ sourceId: plan.sourceId, mask: body.mask === true }).run({ templateId, params: plan.params });
          if (run.status === 'refused') refusal = run.refusal;
        } catch (error) {
          failure = { error };
        }
      }
      const elapsedMs = Math.round(performance.now() - started);
      const summary = run?.status === 'ok' ? summarizeRun(run.result) : undefined;
      const outcome: RunOutcome = summary === undefined ? 'failed' : summary.partial ? 'partial' : 'complete';
      const finished = await plans.finish({ planId: plan.id, userId: request.principalId, outcome, rowCount: summary?.rowCount ?? 0, elapsedMs });
      // the plan is not claimed by this call any more: it is not recorded, so no result and no event follow
      if (finished.status !== 'finished') throw refusalOfPlan('not-runnable');
      await record(request, plan, outcome, paramsHash, summary?.rowCount ?? 0);
      if (failure !== undefined) throw failure.error;
      if (refusal !== undefined) throw new ExtensionRefusal(refusal);
      if (run?.status !== 'ok' || outcome === 'failed') throw new ExtensionRefusal({ code: 'ASK_PLAN_INVALID' });
      return { planId: plan.id, outcome, result: run.result };
    },
  };
}

export const askRunRoute = createAskRunRoute();
