import { BUDGET_DEFAULTS } from '../mapping/budgets.js';
import type { Budgets } from './types.js';

export const DEFAULT_BUDGETS: Budgets = {
  timeoutMs: 5000,
  maxPage: 50,
  requestTimeoutMs: 10_000,
  countCap: 500,
  maxHops: BUDGET_DEFAULTS.maxHops,
  userConcurrency: 2,
  sourceConcurrency: 32,
  queueWaitMs: 2000,
  breaker: { failures: 5, windowMs: 60_000, cooldownMs: 30_000 },
};
