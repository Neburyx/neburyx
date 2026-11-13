import type { ExtensionLogger, ExtensionTask } from '@neburyx/contracts';
import { PLAN_SWEEP_BATCH, PLAN_SWEEP_SCHEDULE, PLAN_SWEEP_TASK, type PlanStore } from './store.js';

export const PLAN_SWEEP_EVENT = 'ask.plans_swept';
export const PLAN_SWEEP_FAILED_EVENT = 'ask.plans_sweep_failed';

/**
 * The recurring task that clears the typed value of the plans that expired unread: every five minutes, at most a batch of them, saying how many it cleared. A failed sweep is logged by its fixed code and
 * not rethrown, so it stops no other task and the next run takes the same plans again.
 */
export function createPlanSweepTask(store: PlanStore, logger: () => ExtensionLogger | undefined): ExtensionTask {
  return {
    name: PLAN_SWEEP_TASK,
    schedule: PLAN_SWEEP_SCHEDULE,
    run: async () => {
      try {
        const cleared = await store.sweep(PLAN_SWEEP_BATCH);
        logger()?.info?.({ event: PLAN_SWEEP_EVENT, cleared }, 'expired plans cleared');
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'PLAN_STORE_FAILED';
        logger()?.warn({ event: PLAN_SWEEP_FAILED_EVENT, code }, 'the sweep of expired plans failed');
      }
    },
  };
}
