import { z } from 'zod';
import type { BudgetsModel } from './model.js';

export const BUDGET_DEFAULTS: BudgetsModel = {
  timeoutMs: 5000,
  maxPage: 50,
  defaultPage: 25,
  maxHops: 4,
  pathResultsCap: 25,
  userConcurrency: 2,
  sourceConcurrency: 32,
  queueWaitMs: 2000,
  breakerFailures: 5,
  breakerWindowMs: 60_000,
  breakerCooldownMs: 30_000,
  heavyOpThreshold: 500,
  requestsPerMinute: 120,
};

export const MIN_DEFAULT_PAGE = 10;

const CEILINGS = {
  timeoutMs: 10_000,
  maxPage: 50,
  maxHops: 4,
  pathResultsCap: 25,
  userConcurrency: 8,
  sourceConcurrency: 256,
  queueWaitMs: 5000,
  breakerFailures: 100,
  breakerTimeMs: 600_000,
} as const;

/** The most hops the budget `max_hops` may name. */
export const MAX_HOPS_CEILING = CEILINGS.maxHops;

function bounded(minimum: number, maximum: number): z.ZodNumber {
  return z.number().int().min(minimum).max(maximum);
}

export const budgetsSchema = z.strictObject({
  timeout_ms: bounded(1, CEILINGS.timeoutMs).optional(),
  max_page: bounded(1, CEILINGS.maxPage).optional(),
  default_page: bounded(MIN_DEFAULT_PAGE, CEILINGS.maxPage).optional(),
  max_hops: bounded(1, CEILINGS.maxHops).optional(),
  path_results_cap: bounded(1, CEILINGS.pathResultsCap).optional(),
  user_concurrency: bounded(1, CEILINGS.userConcurrency).optional(),
  source_concurrency: bounded(1, CEILINGS.sourceConcurrency).optional(),
  queue_wait_ms: bounded(1, CEILINGS.queueWaitMs).optional(),
  breaker_failures: bounded(1, CEILINGS.breakerFailures).optional(),
  breaker_window_ms: bounded(1000, CEILINGS.breakerTimeMs).optional(),
  breaker_cooldown_ms: bounded(1000, CEILINGS.breakerTimeMs).optional(),
  heavy_op_threshold: z.number().int().min(1).optional(),
  requests_per_minute: z.number().int().min(1).optional(),
});

export type RawBudgets = z.infer<typeof budgetsSchema>;

export function resolveBudgets(raw: RawBudgets | undefined): BudgetsModel {
  return {
    timeoutMs: raw?.timeout_ms ?? BUDGET_DEFAULTS.timeoutMs,
    maxPage: raw?.max_page ?? BUDGET_DEFAULTS.maxPage,
    defaultPage: raw?.default_page ?? BUDGET_DEFAULTS.defaultPage,
    maxHops: raw?.max_hops ?? BUDGET_DEFAULTS.maxHops,
    pathResultsCap: raw?.path_results_cap ?? BUDGET_DEFAULTS.pathResultsCap,
    userConcurrency: raw?.user_concurrency ?? BUDGET_DEFAULTS.userConcurrency,
    sourceConcurrency: raw?.source_concurrency ?? BUDGET_DEFAULTS.sourceConcurrency,
    queueWaitMs: raw?.queue_wait_ms ?? BUDGET_DEFAULTS.queueWaitMs,
    breakerFailures: raw?.breaker_failures ?? BUDGET_DEFAULTS.breakerFailures,
    breakerWindowMs: raw?.breaker_window_ms ?? BUDGET_DEFAULTS.breakerWindowMs,
    breakerCooldownMs: raw?.breaker_cooldown_ms ?? BUDGET_DEFAULTS.breakerCooldownMs,
    heavyOpThreshold: raw?.heavy_op_threshold ?? BUDGET_DEFAULTS.heavyOpThreshold,
    requestsPerMinute: raw?.requests_per_minute ?? BUDGET_DEFAULTS.requestsPerMinute,
  };
}
