import { describe, expect, it, vi } from 'vitest';
import { LOCAL_IDENTITY } from '../testing/app-store.js';
import { communityAudit, communityPolicy, communitySeams } from './community-seams.js';
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
  const request = { principal: LOCAL_IDENTITY.principal, sourceId: 'source-a', limits: { userConcurrency: 2, sourceConcurrency: 32, queueWaitMs: 50 }, leaseTtlMs: 60_000 };

  it('is the read slots: a third read of one person waits, and is refused as busy when no slot frees', async () => {
    const { coordinator } = communitySeams();
    const held = await Promise.all([coordinator.acquireRead(request), coordinator.acquireRead(request)]);
    expect(held.map((admission) => admission.status)).toEqual(['granted', 'granted']);
    await expect(coordinator.acquireRead(request)).resolves.toEqual({ status: 'busy' });
    for (const admission of held) if (admission.status === 'granted') await admission.lease.release();
  });

  it('gives each set of seams slots of its own', async () => {
    const first = communitySeams().coordinator;
    const held = await Promise.all([first.acquireRead(request), first.acquireRead(request)]);
    await expect(communitySeams().coordinator.acquireRead(request)).resolves.toMatchObject({ status: 'granted' });
    for (const admission of held) if (admission.status === 'granted') await admission.lease.release();
  });
});
