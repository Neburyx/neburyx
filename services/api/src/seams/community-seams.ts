import type { Availability, AskPlanner, AuditSink, Coordinator, EvidenceStore, PolicyProvider, ReadLease, Seams } from './seams.js';

export const communityPolicy: PolicyProvider = {
  authorizeSource: () => Promise.resolve({ allowed: true }),
};

export const communityAudit: AuditSink = {
  record: () => Promise.resolve(),
};

const unlimitedLease: ReadLease = { release: () => Promise.resolve() };

export const communityCoordinator: Coordinator = {
  acquireRead: () => Promise.resolve({ status: 'granted', lease: unlimitedLease }),
};

export const NOT_IN_THIS_EDITION = 'not_in_this_edition';

const unavailableInCommunity: Availability = { available: false, reason: NOT_IN_THIS_EDITION };

export const communityAskPlanner: AskPlanner = { availability: () => unavailableInCommunity };

export const communityEvidenceStore: EvidenceStore = { availability: () => unavailableInCommunity };

export function communitySeams(): Seams {
  return {
    policy: communityPolicy,
    audit: communityAudit,
    coordinator: communityCoordinator,
    askPlanner: communityAskPlanner,
    evidenceStore: communityEvidenceStore,
  };
}
