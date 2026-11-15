import type { CaseSummarizer } from '@neburyx/contracts';

/** A summarizer that says it is not available, for the tests of a route that is not the summary's. */
export const UNAVAILABLE_SUMMARIZER: CaseSummarizer = {
  maxElements: 0,
  availability: () => ({ available: false, reason: 'not_in_this_edition' }),
  summarize: async () => ({ status: 'timeLimit', calls: 0 }),
};
