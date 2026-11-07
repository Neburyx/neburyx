import type { Budgets } from './types.js';

export const DEFAULT_BUDGETS: Budgets = {
  timeoutMs: 5000,
  maxPage: 50,
  requestTimeoutMs: 10_000,
  countCap: 500,
  userConcurrency: 2,
  sourceConcurrency: 32,
  queueWaitMs: 2000,
};
