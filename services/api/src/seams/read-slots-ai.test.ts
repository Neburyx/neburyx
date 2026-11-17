import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReadSlots, type ReadSlots } from './read-slots.js';
import type { Principal, ReadAccessRequest, ReadAdmission, ReadLease } from './seams.js';

const person = (id: string): Principal => ({ id, displayName: id, role: 'investigator' });
const LIMITS = { userConcurrency: 2, sourceConcurrency: 32, queueWaitMs: 2000 };

function ask(slots: ReadSlots, principal: Principal, origin: 'manual' | 'ai', overrides: Partial<ReadAccessRequest> = {}): Promise<ReadAdmission> {
  return slots.acquireRead({ principal, sourceId: 'source-a', limits: LIMITS, role: 'data', origin, leaseTtlMs: 15_000, ...overrides });
}

async function leaseOf(admission: Promise<ReadAdmission>): Promise<ReadLease> {
  const settled = await admission;
  if (settled.status !== 'granted') throw new Error(`expected a granted read, got ${settled.status}`);
  return settled.lease;
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const statusOf = (admission: Promise<ReadAdmission>): { status?: string } => {
  const seen: { status?: string } = {};
  void admission.then((settled) => (seen.status = settled.status));
  return seen;
};
const aiHeldOf = (slots: ReadSlots, scope: 'sources' | 'users', key: string): number | undefined => slots.inspectAi()[scope].get(key)?.aiHeld;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the share of the slots that AI reads may hold', () => {
  it('lets 16 AI reads of 16 people hold the source of 32 at a share of 0.5, and makes the 17th wait', async () => {
    const slots = createReadSlots({ aiShare: 0.5 });
    for (let index = 0; index < 16; index += 1) await leaseOf(ask(slots, person(`p${index}`), 'ai'));
    const seventeenth = statusOf(ask(slots, person('p16'), 'ai'));
    await flush();
    expect(aiHeldOf(slots, 'sources', 'source-a')).toBe(16);
    expect(seventeenth.status).toBeUndefined();
  });

  it('lets one AI read of a person hold their 2 slots at a share of 0.5, and makes a second wait', async () => {
    const slots = createReadSlots({ aiShare: 0.5 });
    await leaseOf(ask(slots, person('ana'), 'ai'));
    const second = statusOf(ask(slots, person('ana'), 'ai'));
    await flush();
    expect(aiHeldOf(slots, 'users', JSON.stringify(['source-a', 'ana']))).toBe(1);
    expect(second.status).toBeUndefined();
  });

  it('always lets one AI read hold a slot, whatever the share', async () => {
    const slots = createReadSlots({ aiShare: 0.01 });
    await leaseOf(ask(slots, person('ana'), 'ai'));
    expect(aiHeldOf(slots, 'sources', 'source-a')).toBe(1);
  });

  it('grants a manual read at once while AI reads hold their whole share', async () => {
    const slots = createReadSlots({ aiShare: 0.5 });
    await leaseOf(ask(slots, person('ana'), 'ai'));
    await leaseOf(ask(slots, person('ana'), 'manual'));
    expect(slots.inspect().users.get(JSON.stringify(['source-a', 'ana']))).toEqual({ held: 2, waiting: 0 });
  });

  it('serves a manual read queued behind an AI read that is over its share as soon as a slot is free', async () => {
    const slots = createReadSlots({ aiShare: 0.5 });
    const aiLease = await leaseOf(ask(slots, person('ana'), 'ai'));
    const manualLease = await leaseOf(ask(slots, person('ana'), 'manual'));
    const overShare = statusOf(ask(slots, person('ana'), 'ai'));
    const manual = statusOf(ask(slots, person('ana'), 'manual'));
    await flush();
    await manualLease.release();
    await flush();
    expect(manual.status).toBe('granted');
    expect(overShare.status).toBeUndefined();
    await aiLease.release();
    await flush();
    expect(overShare.status).toBe('granted');
  });

  it('refuses an AI read over its share as busy when no AI slot frees within the wait', async () => {
    const slots = createReadSlots({ aiShare: 0.5 });
    await leaseOf(ask(slots, person('ana'), 'ai'));
    const over = statusOf(ask(slots, person('ana'), 'ai'));
    await vi.advanceTimersByTimeAsync(2001);
    expect(over.status).toBe('busy');
  });

  it('takes a cancelled queued AI read out of the queue holding nothing', async () => {
    const slots = createReadSlots({ aiShare: 0.5 });
    await leaseOf(ask(slots, person('ana'), 'ai'));
    const controller = new AbortController();
    const over = statusOf(ask(slots, person('ana'), 'ai', { signal: controller.signal }));
    await flush();
    controller.abort();
    await flush();
    expect(over.status).toBe('cancelled');
    expect(slots.inspectAi().users.get(JSON.stringify(['source-a', 'ana']))).toEqual({ aiHeld: 1, aiWaiting: 0 });
  });

  it('gives an AI count back when the lease expires without release, and when it is released once', async () => {
    const slots = createReadSlots({ aiShare: 0.5 });
    await leaseOf(ask(slots, person('ana'), 'ai', { leaseTtlMs: 1000 }));
    await vi.advanceTimersByTimeAsync(1001);
    expect(slots.inspectAi().sources.size).toBe(0);
    expect(slots.inspectAi().users.size).toBe(0);
    const lease = await leaseOf(ask(slots, person('ana'), 'ai'));
    await lease.release();
    await lease.release();
    expect(slots.inspectAi().sources.size).toBe(0);
  });

  it('gives back the AI count of a read refused as busy while it waited for the source, and keeps the count of one still held', async () => {
    const slots = createReadSlots({ aiShare: 0.5 });
    const limits = { userConcurrency: 2, sourceConcurrency: 1, queueWaitMs: 500 };
    const held = await leaseOf(ask(slots, person('ana'), 'ai', { limits }));
    const waiting = statusOf(ask(slots, person('ben'), 'manual', { limits }));
    await flush();
    await vi.advanceTimersByTimeAsync(501);
    expect(waiting.status).toBe('busy');
    expect(aiHeldOf(slots, 'sources', 'source-a')).toBe(1);
    await held.release();
    expect(slots.inspectAi().sources.size).toBe(0);
  });

  it('reports AI counts that agree with the totals of inspect() for every pool', async () => {
    const slots = createReadSlots({ aiShare: 0.5 });
    await leaseOf(ask(slots, person('ana'), 'ai'));
    await leaseOf(ask(slots, person('ana'), 'manual'));
    await leaseOf(ask(slots, person('ben'), 'ai'));
    statusOf(ask(slots, person('ben'), 'ai'));
    await flush();
    const totals = slots.inspect();
    const ai = slots.inspectAi();
    for (const scope of ['sources', 'users'] as const) {
      expect([...ai[scope].keys()].sort()).toEqual([...totals[scope].keys()].sort());
      for (const [key, counts] of totals[scope]) {
        const aiCounts = ai[scope].get(key);
        expect(aiCounts?.aiHeld).toBeLessThanOrEqual(counts.held);
        expect(aiCounts?.aiWaiting).toBeLessThanOrEqual(counts.waiting);
      }
    }
    expect(totals.sources.get('source-a')).toEqual({ held: 3, waiting: 0 });
    expect(ai.sources.get('source-a')).toEqual({ aiHeld: 2, aiWaiting: 0 });
    expect(totals.users.get(JSON.stringify(['source-a', 'ben']))).toEqual({ held: 1, waiting: 1 });
    expect(ai.users.get(JSON.stringify(['source-a', 'ben']))).toEqual({ aiHeld: 1, aiWaiting: 1 });
  });

  it('holds no AI limit when no share is given', async () => {
    const slots = createReadSlots();
    for (let index = 0; index < 32; index += 1) await leaseOf(ask(slots, person(`p${index}`), 'ai'));
    expect(aiHeldOf(slots, 'sources', 'source-a')).toBe(32);
  });
});
