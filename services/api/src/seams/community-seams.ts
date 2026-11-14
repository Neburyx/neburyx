import { withBreaker } from './breaker.js';
import { createReadSlots } from './read-slots.js';
import type { AskPlanner, AuditSink, PolicyProvider, Seams } from './seams.js';

export const communityPolicy: PolicyProvider = {
  authorizeSource: () => Promise.resolve({ allowed: true }),
};

export const communityAudit: AuditSink = {
  record: () => Promise.resolve(),
};

export const communityAskPlanner: AskPlanner = {
  availability: () => ({ available: false, reason: 'not_in_this_edition' }),
};

/** The Community seams; each call has read slots of its own, so one process builds them once. */
export function communitySeams(): Seams {
  return {
    policy: communityPolicy,
    audit: communityAudit,
    coordinator: withBreaker(createReadSlots()),
    askPlanner: communityAskPlanner,
  };
}
