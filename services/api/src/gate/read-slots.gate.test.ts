import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReadSlots, type ReadSlots } from '../seams/read-slots.js';
import type { Coordinator, ReadAccessRequest } from '../seams/seams.js';
import { DEFAULT_BUDGETS } from './budgets.js';
import type { ExecuteOutcome } from './executor.js';
import { gateRequest, harness, rowsOf, testCatalog, testTemplate, TestExecutor } from '../testing/gate.js';
import type { Budgets } from './types.js';

const ONE_SLOT: Budgets = { ...DEFAULT_BUDGETS, userConcurrency: 1, sourceConcurrency: 4, queueWaitMs: 200 };
const EMPTY = { sources: new Map(), users: new Map() };

/** An executor whose reads wait until the test settles them, one at a time, in order. */
function heldExecutor() {
  const pending: ((outcome: ExecuteOutcome | Error) => void)[] = [];
  const executor = new TestExecutor(
    () =>
      new Promise<ExecuteOutcome>((resolve, reject) => {
        pending.push((outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome)));
      }),
  );
  return { executor, settleNext: (outcome: ExecuteOutcome | Error) => pending.shift()?.(outcome) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the request the gate makes of the coordinator', () => {
  it('carries the source budgets as limits, and the time left to the deadline plus the source timeout as the lease time to live', async () => {
    const requests: ReadAccessRequest[] = [];
    const now = 50_000;
    const coordinator: Coordinator = {
      acquireRead: (request) => {
        requests.push(request);
        return Promise.resolve({ status: 'granted', lease: { release: () => Promise.resolve() } });
      },
    };
    const budgets: Budgets = { ...DEFAULT_BUDGETS, requestTimeoutMs: 8000, userConcurrency: 3, sourceConcurrency: 40, queueWaitMs: 1500 };
    const template = testTemplate({ indexNeeds: () => [] });
    const { gate } = harness({ seams: { coordinator }, budgetsFor: () => budgets, clock: () => now, catalog: testCatalog([template]) });
    await gate.run(gateRequest());
    expect(requests).toHaveLength(1);
    expect(requests[0]?.limits).toEqual({ userConcurrency: 3, sourceConcurrency: 40, queueWaitMs: 1500 });
    expect(requests[0]?.leaseTtlMs).toBe(8000 + budgets.timeoutMs);
  });
});

describe('the wait for a slot', () => {
  it('is cut at the request deadline when that is nearer than the source wait', async () => {
    const requests: ReadAccessRequest[] = [];
    const coordinator: Coordinator = { acquireRead: (request) => (requests.push(request), Promise.resolve({ status: 'busy' })) };
    const { gate } = harness({ seams: { coordinator }, budgetsFor: () => ({ ...DEFAULT_BUDGETS, requestTimeoutMs: 900, queueWaitMs: 2000 }) });
    await expect(gate.run(gateRequest())).rejects.toMatchObject({ code: 'SOURCE_BUSY' });
    expect(requests[0]?.limits.queueWaitMs).toBe(900);
  });

  it('ends at the deadline with the real slots, answering SOURCE_BUSY, never later', async () => {
    const slots = createReadSlots();
    const held = heldExecutor();
    const budgets: Budgets = { ...ONE_SLOT, requestTimeoutMs: 120, queueWaitMs: 2000 };
    const { gate } = harness({ seams: { coordinator: slots }, executor: held.executor, budgetsFor: () => budgets, clock: () => Date.now() });
    const first = gate.run(gateRequest()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const second = gate.run(gateRequest()).catch((error: unknown) => error);
    const order: string[] = [];
    void second.then(() => order.push('second'));
    await vi.advanceTimersByTimeAsync(119);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toMatchObject({ code: 'SOURCE_BUSY' });
    held.settleNext(rowsOf(1));
    await first;
  });
});

describe('a read refused for want of a slot', () => {
  it('answers SOURCE_BUSY after the wait and calls no executor for it', async () => {
    const slots = createReadSlots();
    const held = heldExecutor();
    const { gate } = harness({ seams: { coordinator: slots }, executor: held.executor, budgetsFor: () => ONE_SLOT, clock: () => Date.now() });
    const first = gate.run(gateRequest());
    await vi.advanceTimersByTimeAsync(0);
    const second = gate.run(gateRequest()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(200);
    await expect(second).resolves.toMatchObject({ code: 'SOURCE_BUSY' });
    expect(held.executor.calls).toHaveLength(1);
    held.settleNext(rowsOf(1));
    await first;
    expect(slots.inspect()).toEqual(EMPTY);
  });
});

describe('a read that ends in a failure', () => {
  it.each([
    ['a timeout', { status: 'timeout' } as ExecuteOutcome, 'QUERY_TIMEOUT'],
    ['an unavailable source', { status: 'unavailable', reason: 'unreachable' } as ExecuteOutcome, 'SOURCE_UNAVAILABLE'],
    ['an error the executor throws', new Error('driver fault'), 'INTERNAL_ERROR'],
  ])('frees its slot on %s, so the read waiting for it runs at once', async (_name, outcome, code) => {
    const slots = createReadSlots();
    const held = heldExecutor();
    const { gate } = harness({ seams: { coordinator: slots }, executor: held.executor, budgetsFor: () => ONE_SLOT, clock: () => Date.now() });
    const first = gate.run(gateRequest()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const second = gate.run(gateRequest());
    await vi.advanceTimersByTimeAsync(50);
    expect(held.executor.calls).toHaveLength(1);
    held.settleNext(outcome);
    await expect(first).resolves.toMatchObject({ code });
    await vi.advanceTimersByTimeAsync(0);
    expect(held.executor.calls).toHaveLength(2);
    held.settleNext(rowsOf(1));
    await expect(second).resolves.toMatchObject({ hasMore: false });
    expect(slots.inspect()).toEqual(EMPTY);
  });
});

describe('a lease whose release throws', () => {
  it('leaves the answer as it was, logs the failure, and frees its slots at its expiry', async () => {
    const slots = createReadSlots();
    const lost: Coordinator = {
      acquireRead: async (request) => {
        const admission = await slots.acquireRead(request);
        return admission.status === 'granted' ? { status: 'granted', lease: { release: () => Promise.reject(new Error('store gone')) } } : admission;
      },
    };
    const { gate, logs } = harness({ seams: { coordinator: lost }, budgetsFor: () => ONE_SLOT, clock: () => Date.now() });
    await expect(gate.run(gateRequest())).resolves.toMatchObject({ hasMore: false });
    expect(logs.map((entry) => entry.fields)).toEqual([{ event: 'gate.lease_release_failed' }]);
    expect(slots.inspect().sources.get('source-a')).toEqual({ held: 1, waiting: 0 });
    await vi.advanceTimersByTimeAsync(ONE_SLOT.requestTimeoutMs + ONE_SLOT.timeoutMs);
    expect(slots.inspect()).toEqual(EMPTY);
  });
});

describe('the system runner', () => {
  it('takes a source slot while a user holds theirs, under the source limit', async () => {
    const slots: ReadSlots = createReadSlots();
    const held = heldExecutor();
    const template = testTemplate({ id: 'system-read', scope: 'system' });
    const { gate, system } = harness({ seams: { coordinator: slots }, executor: held.executor, budgetsFor: () => ONE_SLOT, clock: () => Date.now(), catalog: testCatalog([testTemplate(), template]) });
    const person = gate.run(gateRequest());
    await vi.advanceTimersByTimeAsync(0);
    const ping = system.run({ traceId: 'tr-ping', sourceId: 'source-a', templateId: 'system-read', params: { key: 'k' }, limit: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(held.executor.calls).toHaveLength(2);
    expect(slots.inspect().sources.get('source-a')).toEqual({ held: 2, waiting: 0 });
    held.settleNext(rowsOf(1));
    held.settleNext(rowsOf(1));
    await Promise.all([person, ping]);
    expect(slots.inspect()).toEqual(EMPTY);
  });
});

/** An executor that answers at once and says its connection comes back only when the test lets it. */
function closingExecutor() {
  const closings: (() => void)[] = [];
  const executor = new TestExecutor((call) => {
    call.onClosed?.(new Promise<void>((resolve) => void closings.push(resolve)));
    return Promise.resolve(rowsOf(1));
  });
  return { executor, closeAll: () => closings.splice(0).forEach((close) => close()), closings };
}

describe('a read whose connection is still closing when it answers', () => {
  it('answers at once and keeps its slots until the connection is back', async () => {
    const slots = createReadSlots();
    const closing = closingExecutor();
    const { gate } = harness({ seams: { coordinator: slots }, executor: closing.executor, budgetsFor: () => ONE_SLOT, clock: () => Date.now() });
    await expect(gate.run(gateRequest())).resolves.toMatchObject({ hasMore: false });
    expect(slots.inspect().sources.get('source-a')).toEqual({ held: 1, waiting: 0 });
    closing.closeAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(slots.inspect()).toEqual(EMPTY);
  });

  it('keeps the one lease of a request of several pages until every page has its connection back', async () => {
    const slots = createReadSlots();
    const closing = closingExecutor();
    const { gate } = harness({ seams: { coordinator: slots }, executor: closing.executor, budgetsFor: () => ONE_SLOT, clock: () => Date.now() });
    const pages = await gate.runMany([gateRequest(), gateRequest(), gateRequest()]);
    expect(pages).toHaveLength(3);
    expect(closing.closings).toHaveLength(3);
    expect(slots.inspect().sources.get('source-a')).toEqual({ held: 1, waiting: 0 });
    const [first, second] = closing.closings;
    first?.();
    second?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(slots.inspect().sources.get('source-a')).toEqual({ held: 1, waiting: 0 });
    closing.closeAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(slots.inspect()).toEqual(EMPTY);
  });

  it('gives its slots back at once when it says nothing of its connection', async () => {
    const slots = createReadSlots();
    const { gate } = harness({ seams: { coordinator: slots }, budgetsFor: () => ONE_SLOT, clock: () => Date.now() });
    await gate.run(gateRequest());
    expect(slots.inspect()).toEqual(EMPTY);
  });
});
