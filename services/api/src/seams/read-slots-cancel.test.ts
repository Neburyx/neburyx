import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReadSlots } from './read-slots.js';
import type { Principal, ReadAccessRequest, ReadAdmission } from './seams.js';

const person = (id: string): Principal => ({ id, displayName: id, role: 'investigator' });
const [ANA, BEN, CAL] = [person('ana'), person('ben'), person('cal')];
const LIMITS = { userConcurrency: 1, sourceConcurrency: 1, queueWaitMs: 2000 };

const ask = (slots: ReturnType<typeof createReadSlots>, principal: Principal, overrides: Partial<ReadAccessRequest> = {}): Promise<ReadAdmission> =>
  slots.acquireRead({ principal, sourceId: 'source-a', limits: LIMITS, role: 'data', leaseTtlMs: 15_000, ...overrides });
const flush = () => vi.advanceTimersByTimeAsync(0);
const statuses = (admissions: readonly Promise<ReadAdmission>[]): string[] => {
  const order: string[] = [];
  admissions.forEach((admission, index) => void admission.then((settled) => order.push(`${index}:${settled.status}`)));
  return order;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('a read waiting for the user\'s slot', () => {
  it('leaves the queue as cancelled, not busy, holds nothing, and the reads behind it keep their order', async () => {
    const slots = createReadSlots();
    const held = await ask(slots, ANA);
    if (held.status !== 'granted') throw new Error('not granted');
    const controller = new AbortController();
    const cancelled = ask(slots, ANA, { signal: controller.signal });
    const behind = ask(slots, ANA);
    const order = statuses([cancelled, behind]);
    await flush();
    controller.abort();
    await flush();
    expect(order).toEqual(['0:cancelled']);
    expect(slots.inspect().users.get(JSON.stringify(['source-a', 'ana']))).toEqual({ held: 1, waiting: 1 });
    await held.lease.release();
    await flush();
    expect(order).toEqual(['0:cancelled', '1:granted']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(order).toEqual(['0:cancelled', '1:granted']);
  });
});

describe('a read that holds the user\'s slot and waits for the source\'s', () => {
  it('gives the user\'s slot back when it is cancelled', async () => {
    const slots = createReadSlots();
    const other = await ask(slots, BEN);
    if (other.status !== 'granted') throw new Error('not granted');
    const controller = new AbortController();
    const waiting = ask(slots, ANA, { signal: controller.signal });
    const order = statuses([waiting]);
    await flush();
    expect(slots.inspect().users.get(JSON.stringify(['source-a', 'ana']))).toEqual({ held: 1, waiting: 0 });
    controller.abort();
    await flush();
    expect(order).toEqual(['0:cancelled']);
    expect(slots.inspect().users.size).toBe(1);
    expect(slots.inspect().sources.get('source-a')).toEqual({ held: 1, waiting: 0 });
    await other.lease.release();
    expect(slots.inspect().sources.size).toBe(0);
    expect(slots.inspect().users.size).toBe(0);
  });

  it('lets a read behind it on the source take the slot the cancelled read leaves', async () => {
    const slots = createReadSlots();
    const other = await ask(slots, BEN);
    if (other.status !== 'granted') throw new Error('not granted');
    const controller = new AbortController();
    const cancelled = ask(slots, ANA, { signal: controller.signal });
    const behind = ask(slots, CAL);
    const order = statuses([cancelled, behind]);
    await flush();
    controller.abort();
    await flush();
    await other.lease.release();
    await flush();
    expect(order).toEqual(['0:cancelled', '1:granted']);
  });
});

describe('a signal that is already aborted', () => {
  it('answers cancelled at once and touches no slot', async () => {
    const slots = createReadSlots();
    const controller = new AbortController();
    controller.abort();
    expect(await ask(slots, ANA, { signal: controller.signal })).toEqual({ status: 'cancelled' });
    expect(slots.inspect().users.size).toBe(0);
    expect(slots.inspect().sources.size).toBe(0);
  });
});

describe('an abort after the read was granted', () => {
  it('changes nothing about the lease, and the slot is freed by its release once', async () => {
    const slots = createReadSlots();
    const controller = new AbortController();
    const admission = await ask(slots, ANA, { signal: controller.signal });
    if (admission.status !== 'granted') throw new Error('not granted');
    controller.abort();
    await flush();
    expect(slots.inspect().sources.get('source-a')).toEqual({ held: 1, waiting: 0 });
    await admission.lease.release();
    await admission.lease.release();
    expect(slots.inspect().sources.size).toBe(0);
  });
});
