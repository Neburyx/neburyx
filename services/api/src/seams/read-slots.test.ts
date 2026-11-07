import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReadSlots, type ReadSlots } from './read-slots.js';
import type { Principal, ReadAccessRequest, ReadAdmission, ReadLease } from './seams.js';

const user = (id: string): Principal => ({ id, displayName: id, role: 'investigator' });
const ANA = user('ana');
const BEN = user('ben');
const CAL = user('cal');
const DEE = user('dee');

const LIMITS = { userConcurrency: 2, sourceConcurrency: 32, queueWaitMs: 2000 };

function ask(slots: ReadSlots, principal: Principal, overrides: Partial<ReadAccessRequest> = {}): Promise<ReadAdmission> {
  return slots.acquireRead({ principal, sourceId: 'source-a', limits: LIMITS, leaseTtlMs: 15_000, ...overrides });
}

async function leaseOf(admission: Promise<ReadAdmission>): Promise<ReadLease> {
  const settled = await admission;
  if (settled.status !== 'granted') throw new Error(`expected a granted read, got ${settled.status}`);
  return settled.lease;
}

/** Lets the promises that a timer or a release settled run their reactions. */
const flush = () => vi.advanceTimersByTimeAsync(0);

/** Records the order in which admissions settle, and their status. */
function track(admissions: readonly Promise<ReadAdmission>[]): string[] {
  const order: string[] = [];
  admissions.forEach((admission, index) => void admission.then((settled) => order.push(`${index}:${settled.status}`)));
  return order;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a user with both slots held', () => {
  it('waits for a third read and runs it when one of the two ends within the wait', async () => {
    const slots = createReadSlots();
    const [first] = await Promise.all([leaseOf(ask(slots, ANA)), leaseOf(ask(slots, ANA))]);
    const third = ask(slots, ANA);
    const order = track([third]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(order).toEqual([]);
    await first?.release();
    await flush();
    expect(order).toEqual(['0:granted']);
  });

  it('refuses the third read as busy when no slot frees within the wait, and not before', async () => {
    const slots = createReadSlots();
    await Promise.all([leaseOf(ask(slots, ANA)), leaseOf(ask(slots, ANA))]);
    const order = track([ask(slots, ANA)]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(['0:busy']);
    expect(slots.inspect().users.get(JSON.stringify(['source-a', 'ana']))).toEqual({ held: 2, waiting: 0 });
  });

  it('serves waiting reads in the order they started to wait', async () => {
    const slots = createReadSlots();
    const held = await Promise.all([leaseOf(ask(slots, ANA)), leaseOf(ask(slots, ANA))]);
    const order = track([ask(slots, ANA), ask(slots, ANA), ask(slots, ANA)]);
    for (const lease of held) await lease.release();
    await flush();
    expect(order).toEqual(['0:granted', '1:granted']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(order).toEqual(['0:granted', '1:granted', '2:busy']);
  });

  it('does not hold back a read of the same user on another source, or of another user on the source', async () => {
    const slots = createReadSlots();
    await Promise.all([leaseOf(ask(slots, ANA)), leaseOf(ask(slots, ANA))]);
    const order = track([ask(slots, ANA, { sourceId: 'source-b' }), ask(slots, BEN)]);
    await flush();
    expect(order).toEqual(['0:granted', '1:granted']);
  });
});

describe('the source limit', () => {
  const small = { ...LIMITS, sourceConcurrency: 3 };

  it('holds across users: a fourth user waits, and runs when one of the three ends within the wait', async () => {
    const slots = createReadSlots();
    const held = await Promise.all([ANA, BEN, CAL].map((principal) => leaseOf(ask(slots, principal, { limits: small }))));
    const order = track([ask(slots, DEE, { limits: small })]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual([]);
    await held[1]?.release();
    await flush();
    expect(order).toEqual(['0:granted']);
  });

  it('refuses a fourth user as busy after the wait', async () => {
    const slots = createReadSlots();
    await Promise.all([ANA, BEN, CAL].map((principal) => leaseOf(ask(slots, principal, { limits: small }))));
    const order = track([ask(slots, DEE, { limits: small })]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(order).toEqual(['0:busy']);
  });

  it('counts one wait for both slots and gives the user slot back when the source slot does not free', async () => {
    const one = { ...LIMITS, userConcurrency: 1, sourceConcurrency: 1 };
    const slots = createReadSlots();
    const ben = await leaseOf(ask(slots, BEN, { limits: one }));
    const ana = ask(slots, ANA, { limits: one });
    const order = track([ana]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(order).toEqual(['0:busy']);
    expect(slots.inspect().users.has(JSON.stringify(['source-a', 'ana']))).toBe(false);
    await ben.release();
    await expect(ask(slots, ANA, { limits: one })).resolves.toMatchObject({ status: 'granted' });
  });

  it('lets a user waiting for the source slot keep their place while their own slot is held', async () => {
    const one = { ...LIMITS, userConcurrency: 2, sourceConcurrency: 1 };
    const slots = createReadSlots();
    const ben = await leaseOf(ask(slots, BEN, { limits: one }));
    const order = track([ask(slots, ANA, { limits: one }), ask(slots, CAL, { limits: one })]);
    await vi.advanceTimersByTimeAsync(500);
    await ben.release();
    await flush();
    expect(order).toEqual(['0:granted']);
  });
});

describe('a lease', () => {
  it('frees both slots when it is never released, at its time to live, and says so', async () => {
    const expired: string[] = [];
    const one = { ...LIMITS, userConcurrency: 1 };
    const slots = createReadSlots({ onExpired: (sourceId) => expired.push(sourceId) });
    await leaseOf(ask(slots, ANA, { limits: one, leaseTtlMs: 15_000 }));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(slots.inspect().sources.get('source-a')).toEqual({ held: 1, waiting: 0 });
    await vi.advanceTimersByTimeAsync(1);
    expect(expired).toEqual(['source-a']);
    expect(slots.inspect()).toEqual({ sources: new Map(), users: new Map() });
    await expect(ask(slots, ANA, { limits: one })).resolves.toMatchObject({ status: 'granted' });
  });

  it('runs a read that waits for it when it expires', async () => {
    const one = { ...LIMITS, userConcurrency: 1, queueWaitMs: 5000 };
    const slots = createReadSlots();
    await leaseOf(ask(slots, ANA, { limits: one, leaseTtlMs: 3000 }));
    const order = track([ask(slots, ANA, { limits: one })]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(order).toEqual(['0:granted']);
  });

  it('frees its slots once, whether released twice or released after it expired', async () => {
    const one = { ...LIMITS, userConcurrency: 1, sourceConcurrency: 1 };
    const slots = createReadSlots();
    const first = await leaseOf(ask(slots, ANA, { limits: one, leaseTtlMs: 1000 }));
    await first.release();
    const second = await leaseOf(ask(slots, ANA, { limits: one }));
    await first.release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(slots.inspect().sources.get('source-a')).toEqual({ held: 1, waiting: 0 });
    await second.release();
    const third = await leaseOf(ask(slots, ANA, { limits: one, leaseTtlMs: 500 }));
    await vi.advanceTimersByTimeAsync(500);
    const fourth = await leaseOf(ask(slots, ANA, { limits: one }));
    await third.release();
    expect(slots.inspect().sources.get('source-a')).toEqual({ held: 1, waiting: 0 });
    await fourth.release();
    expect(slots.inspect()).toEqual({ sources: new Map(), users: new Map() });
  });
});

describe('the tables', () => {
  it('hold no entry once every lease is released and every wait has ended', async () => {
    const slots = createReadSlots();
    const leases = await Promise.all([leaseOf(ask(slots, ANA)), leaseOf(ask(slots, ANA)), leaseOf(ask(slots, BEN, { sourceId: 'source-b' }))]);
    const busy = ask(slots, ANA);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(busy).resolves.toEqual({ status: 'busy' });
    for (const lease of leases) await lease.release();
    expect(slots.inspect()).toEqual({ sources: new Map(), users: new Map() });
  });

  it('cancel the wait timer of a granted read, so nothing is left scheduled', async () => {
    const slots = createReadSlots();
    const lease = await leaseOf(ask(slots, ANA));
    await lease.release();
    expect(vi.getTimerCount()).toBe(0);
  });
});
