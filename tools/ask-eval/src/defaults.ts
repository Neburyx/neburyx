/** What a plan leaves out and the gate fills in; each value mirrors the code that applies it (`defaults.test.ts` compares them). */
export const ASK_EVAL_DEFAULTS = {
  minShared: 1,
  maxHops: 1,
  expandDirection: 'both',
  expandSort: 'observed',
  defaultPage: 25,
} as const;
