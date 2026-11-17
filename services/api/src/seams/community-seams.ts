import { withBreaker } from './breaker.js';
import { createReadSlots } from './read-slots.js';
import type { AskClassifier, AuditSink, CaseSummarizer, PolicyProvider, Seams } from './seams.js';

export const communityPolicy: PolicyProvider = {
  authorizeSource: () => Promise.resolve({ allowed: true }),
};

export const communityAudit: AuditSink = {
  record: () => Promise.resolve(),
};

export const communityAskClassifier: AskClassifier = {
  availability: () => ({ available: false, reason: 'not_in_this_edition' }),
  classify: () => Promise.resolve({ ok: false, cause: 'unavailable' }),
};

export const communityCaseSummarizer: CaseSummarizer = {
  maxElements: 0,
  availability: () => ({ available: false, reason: 'not_in_this_edition' }),
  summarize: () => Promise.reject(new Error('the case summary is not available in this edition')),
};

/** The Community seams; each call has read slots of its own, so one process builds them once. `aiShare` is the share of each pool of slots that AI reads may hold. */
export function communitySeams(options: { readonly aiShare?: number } = {}): Seams {
  return {
    policy: communityPolicy,
    audit: communityAudit,
    coordinator: withBreaker(createReadSlots(options.aiShare === undefined ? {} : { aiShare: options.aiShare })),
    askClassifier: communityAskClassifier,
    caseSummarizer: communityCaseSummarizer,
  };
}
