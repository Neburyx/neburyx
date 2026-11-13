import type { PlanStore, StoredPlan } from '@neburyx/ee-ask';

export const LISTED_PLAN_ID = '01939999-0000-7000-8000-0000000000bb';
export const LISTED_PLAN_EXPIRY = new Date('2026-11-13T10:15:00.000Z');

export interface ListedRun {
  readonly planId: string;
  readonly actorId: string;
  readonly outcome: string;
  readonly rowCount: number;
}

/**
 * A plan store that keeps the plans it is given in a list, with the states of a plan and none of its clock, so a route's answer can be read without a database. A test can put a plan in it with `put`.
 * The Postgres tests prove the real store.
 */
export function createListPlanStore(): PlanStore & { readonly stored: StoredPlan[]; readonly runs: ListedRun[]; put(plan: Partial<StoredPlan> & Pick<StoredPlan, 'userId'>): StoredPlan } {
  const stored: StoredPlan[] = [];
  const runs: ListedRun[] = [];
  const mine = (planId: string, userId: string): StoredPlan | undefined => stored.find((plan) => plan.id === planId && plan.userId === userId);
  const change = (plan: StoredPlan, state: StoredPlan['state']): StoredPlan => {
    const next = { ...plan, state };
    stored[stored.indexOf(plan)] = next;
    return next;
  };
  const unused = (): Promise<never> => Promise.reject(new Error('not used'));
  const put = (fields: Partial<StoredPlan> & Pick<StoredPlan, 'userId'>): StoredPlan => {
    const plan: StoredPlan = { id: LISTED_PLAN_ID, sourceId: 'demo', turnId: undefined, templateId: 'entity', templateVersion: 1, params: {}, state: 'proposed', parentPlanId: undefined, planningTraceId: 'tr', createdAt: new Date(), expiresAt: LISTED_PLAN_EXPIRY, ...fields };
    stored.push(plan);
    return plan;
  };
  return {
    stored,
    runs,
    put,
    insert: async (fields) => put({ userId: fields.userId, sourceId: fields.sourceId, templateId: fields.templateId, templateVersion: fields.templateVersion, params: fields.params, planningTraceId: fields.planningTraceId }),
    get: async (planId, userId) => mine(planId, userId),
    claim: async (planId, userId) => {
      const plan = mine(planId, userId);
      if (plan === undefined) return { status: 'absent' };
      if (plan.state !== 'proposed') return { status: plan.state === 'expired' ? 'expired' : 'not-runnable' };
      return { status: 'claimed', plan: change(plan, 'confirmed') };
    },
    cancel: unused,
    edit: unused,
    finish: async (finish) => {
      const plan = mine(finish.planId, finish.userId);
      if (plan === undefined || plan.state !== 'confirmed') return { status: 'not-runnable' };
      change(plan, 'run');
      runs.push({ planId: plan.id, actorId: finish.userId, outcome: finish.outcome, rowCount: finish.rowCount });
      return { status: 'finished', runId: LISTED_PLAN_ID };
    },
    sweep: async () => 0,
    close: async () => undefined,
  };
}
