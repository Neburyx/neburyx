import { describe, expect, it, vi } from 'vitest';
import { LOCAL_IDENTITY } from '../testing/app-store.js';
import { communityAudit, communityCoordinator, communityPolicy } from './community-seams.js';
import type { AuditEvent } from './seams.js';

describe('the Community policy provider', () => {
  it.each(['source-a', 'source-b', ''])('allows the local principal for source %j', async (sourceId) => {
    const decision = await communityPolicy.authorizeSource({ principal: LOCAL_IDENTITY.principal, sourceId });
    expect(decision).toEqual({ allowed: true });
  });
});

describe('the Community audit sink', () => {
  const event: AuditEvent = Object.freeze({
    actorId: LOCAL_IDENTITY.principal.id,
    actorRole: LOCAL_IDENTITY.principal.role,
    action: 'graph.expand',
    result: 'success',
    sourceId: 'source-a',
    traceId: 'tr-1',
  });

  it('resolves with no value and leaves the event unchanged', async () => {
    const before = structuredClone(event);
    await expect(communityAudit.record(event)).resolves.toBeUndefined();
    expect(event).toEqual(before);
  });

  it('writes nothing to the standard output or error streams', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await communityAudit.record(event);
      expect(out).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it('has no member that holds events', () => {
    expect(Object.keys(communityAudit)).toEqual(['record']);
  });
});

describe('the Community coordinator', () => {
  it('grants every one of 100 read requests for one principal and source without a release', async () => {
    const request = { principal: LOCAL_IDENTITY.principal, sourceId: 'source-a' };
    const admissions = await Promise.all(Array.from({ length: 100 }, () => communityCoordinator.acquireRead(request)));
    expect(admissions.every((admission) => admission.status === 'granted')).toBe(true);
  });

  it('resolves when a lease is released', async () => {
    const admission = await communityCoordinator.acquireRead({ principal: LOCAL_IDENTITY.principal, sourceId: 'source-a' });
    if (admission.status !== 'granted') throw new Error('expected a granted read');
    await expect(admission.lease.release()).resolves.toBeUndefined();
  });
});
