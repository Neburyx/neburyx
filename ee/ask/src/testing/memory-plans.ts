import { PLAN_LIFETIME_MINUTES, type CancelResult, type ClaimResult, type EditResult, type FinishResult, type NewPlan, type PlanRefusal, type PlanStore, type StoredPlan } from '../plans/index.js';

export interface MemoryRun {
  readonly id: string;
  readonly planId: string;
  readonly actorId: string;
  readonly outcome: string;
  readonly rowCount: number;
  readonly elapsedMs: number;
}

export interface MemoryPlanStore extends PlanStore {
  /** The plans as stored, in the order they were inserted. */
  readonly plans: StoredPlan[];
  readonly runs: MemoryRun[];
  /** Moves the clock of the store forward. */
  advance(milliseconds: number): void;
  /** Makes the next call of the named method fail as a store failure does. */
  failNext(method: Exclude<keyof PlanStore, 'close'>): void;
}

/** A plan store that keeps its plans in memory with the states and answers of the real one, for tests of what is built on it. The Postgres tests prove the real one. */
export function createMemoryPlanStore(): MemoryPlanStore {
  const plans: StoredPlan[] = [];
  const runs: MemoryRun[] = [];
  const failing = new Set<string>();
  let now = Date.parse('2026-11-13T10:00:00Z');
  let counter = 0;
  const id = (): string => `01939999-0000-7000-8000-${String((counter += 1)).padStart(12, '0')}`;
  /** The parameters of a plan that can no longer run: the typed text of a search is gone. */
  const scrubbed = (plan: StoredPlan): unknown => {
    if (plan.templateId !== 'search' || typeof plan.params !== 'object' || plan.params === null) return plan.params;
    const { text: _typed, ...rest } = plan.params as Record<string, unknown>;
    return rest;
  };
  const replace = (plan: StoredPlan, changes: Partial<StoredPlan>): StoredPlan => {
    const next = { ...plan, ...changes };
    plans[plans.indexOf(plan)] = next;
    return next;
  };
  const refusalOf = (plan: StoredPlan | undefined): PlanRefusal => {
    if (plan === undefined) return 'absent';
    if (plan.state === 'expired') return 'expired';
    if (plan.state === 'proposed' && plan.expiresAt.getTime() <= now) {
      replace(plan, { state: 'expired', params: scrubbed(plan) });
      return 'expired';
    }
    return 'not-runnable';
  };
  const insertPlan = (fields: NewPlan, parent: string | undefined): StoredPlan => {
    const plan: StoredPlan = { id: id(), userId: fields.userId, sourceId: fields.sourceId, turnId: fields.turnId, templateId: fields.templateId, templateVersion: fields.templateVersion, params: structuredClone(fields.params), state: 'proposed', parentPlanId: parent, planningTraceId: fields.planningTraceId, createdAt: new Date(now), expiresAt: new Date(now + PLAN_LIFETIME_MINUTES * 60_000) };
    plans.push(plan);
    return plan;
  };
  const mine = (planId: string, userId: string): StoredPlan | undefined => plans.find((plan) => plan.id === planId && plan.userId === userId);
  const runnable = (plan: StoredPlan | undefined): plan is StoredPlan => plan !== undefined && plan.state === 'proposed' && plan.expiresAt.getTime() > now;

  const store: MemoryPlanStore = {
    plans,
    runs,
    advance: (milliseconds) => void (now += milliseconds),
    failNext: (method) => void failing.add(method),
    get: async (planId, userId) => mine(planId, userId),
    insert: async (fields) => insertPlan(fields, undefined),
    claim: async (planId, userId): Promise<ClaimResult> => {
      const plan = mine(planId, userId);
      if (!runnable(plan)) return { status: refusalOf(plan) };
      // the claim gives the parameters the plan had for the run and keeps the scrubbed ones
      replace(plan, { state: 'confirmed', params: scrubbed(plan) });
      return { status: 'claimed', plan: { ...plan, state: 'confirmed' } };
    },
    cancel: async (planId, userId): Promise<CancelResult> => {
      const plan = mine(planId, userId);
      if (!runnable(plan)) return { status: refusalOf(plan) };
      replace(plan, { state: 'cancelled', params: scrubbed(plan) });
      return { status: 'cancelled' };
    },
    edit: async (edit): Promise<EditResult> => {
      const plan = mine(edit.planId, edit.userId);
      if (!runnable(plan)) return { status: refusalOf(plan) };
      replace(plan, { state: 'cancelled', params: scrubbed(plan) });
      return { status: 'edited', plan: insertPlan({ userId: edit.userId, sourceId: plan.sourceId, ...(plan.turnId === undefined ? {} : { turnId: plan.turnId }), templateId: edit.templateId, templateVersion: edit.templateVersion, params: edit.params, planningTraceId: plan.planningTraceId }, plan.id) };
    },
    finish: async (finish): Promise<FinishResult> => {
      const plan = mine(finish.planId, finish.userId);
      if (plan === undefined || plan.state !== 'confirmed') return { status: 'not-runnable' };
      replace(plan, { state: 'run' });
      const run: MemoryRun = { id: id(), planId: plan.id, actorId: finish.userId, outcome: finish.outcome, rowCount: finish.rowCount, elapsedMs: finish.elapsedMs };
      runs.push(run);
      return { status: 'finished', runId: run.id };
    },
    sweep: async (limit) => {
      const late = plans.filter((plan) => plan.state === 'proposed' && plan.expiresAt.getTime() <= now).sort((left, right) => left.expiresAt.getTime() - right.expiresAt.getTime()).slice(0, limit);
      for (const plan of late) replace(plan, { state: 'expired', params: scrubbed(plan) });
      return late.length;
    },
    close: async () => undefined,
  };
  // a method that was told to fail fails once, as the store does for any statement: with a fixed code and no text of the database
  const own = new Set(['advance', 'failNext', 'close']);
  const methods = store as unknown as Record<string, unknown>;
  for (const [name, original] of Object.entries(methods)) {
    if (typeof original !== 'function' || own.has(name)) continue;
    methods[name] = async (...args: unknown[]): Promise<unknown> => {
      if (failing.delete(name)) throw Object.assign(new Error('the plan store could not complete the call'), { code: 'PLAN_STORE_FAILED', name: 'PlanStoreError' });
      return (original as (...inner: unknown[]) => unknown)(...args);
    };
  }
  return store;
}
