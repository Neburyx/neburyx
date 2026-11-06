import type { AuditSink, Coordinator, PolicyProvider, ReadLease, Seams } from './seams.js';

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

export function communitySeams(): Seams {
  return {
    policy: communityPolicy,
    audit: communityAudit,
    coordinator: communityCoordinator,
  };
}
