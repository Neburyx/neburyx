import { describe, expect, it } from 'vitest';
import { RequestCancelled } from '../errors.js';
import type { AuditEvent, Coordinator } from '../seams/seams.js';
import { gateRequest, harness, TestExecutor } from '../testing/gate.js';

const audit = () => {
  const events: AuditEvent[] = [];
  return { events, sink: { record: (event: AuditEvent) => Promise.resolve(void events.push(event)) } };
};

describe('a read the adapter ended as cancelled', () => {
  it('fails the run with RequestCancelled itself: no internal-error log, audited failed, the lease released once', async () => {
    const { events, sink } = audit();
    let releases = 0;
    const coordinator: Coordinator = { acquireRead: () => Promise.resolve({ status: 'granted', lease: { release: () => (releases++, Promise.resolve()) } }) };
    const executor = new TestExecutor(() => Promise.resolve({ status: 'cancelled' }));
    const { gate, logs } = harness({ executor, seams: { coordinator, audit: sink } });
    const signal = new AbortController().signal;
    await expect(gate.run(gateRequest({ signal }))).rejects.toBeInstanceOf(RequestCancelled);
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.signal).toBe(signal);
    expect(events.map((event) => event.result)).toEqual(['failed']);
    expect(logs.map((entry) => (entry.fields as { event?: string }).event)).not.toContain('gate.internal_error');
    expect(releases).toBe(1);
  });

  it('does the same for a request of several pages', async () => {
    const { events, sink } = audit();
    const executor = new TestExecutor(() => Promise.resolve({ status: 'cancelled' }));
    const { gate, logs } = harness({ executor, seams: { audit: sink } });
    const signal = new AbortController().signal;
    await expect(gate.runMany([gateRequest({ signal }), gateRequest({ signal })])).rejects.toBeInstanceOf(RequestCancelled);
    expect(executor.calls).toHaveLength(1);
    expect(events.map((event) => event.result)).toEqual(['failed']);
    expect(logs.map((entry) => (entry.fields as { event?: string }).event)).not.toContain('gate.internal_error');
  });
});

describe('the lease of a cancelled read', () => {
  it('is released only when the read\'s session has closed, and then once', async () => {
    let releases = 0;
    const coordinator: Coordinator = { acquireRead: () => Promise.resolve({ status: 'granted', lease: { release: () => (releases++, Promise.resolve()) } }) };
    let closed: () => void = () => undefined;
    const executor = new TestExecutor((call) => {
      call.onClosed?.(new Promise<void>((resolve) => (closed = resolve)));
      return Promise.resolve({ status: 'cancelled' });
    });
    const { gate } = harness({ executor, seams: { coordinator } });
    await expect(gate.run(gateRequest({ signal: new AbortController().signal }))).rejects.toBeInstanceOf(RequestCancelled);
    await new Promise((resolve) => setImmediate(resolve));
    expect(releases).toBe(0);
    closed();
    await new Promise((resolve) => setImmediate(resolve));
    expect(releases).toBe(1);
  });
});

describe('a cancel', () => {
  it('is not an AppError, so no check of an error code takes it for an internal error, and its audit result is failed', async () => {
    const { auditResultFor } = await import('./audit.js');
    const { AppError } = await import('../errors.js');
    expect(new RequestCancelled()).not.toBeInstanceOf(AppError);
    expect(auditResultFor(new RequestCancelled())).toBe('failed');
  });
});

describe('a request whose signal is already aborted', () => {
  it('takes no lease, calls no executor and is audited failed', async () => {
    const { events, sink } = audit();
    let leases = 0;
    const coordinator: Coordinator = { acquireRead: () => (leases++, Promise.reject(new Error('not reached'))) };
    const executor = new TestExecutor();
    const { gate } = harness({ executor, seams: { coordinator, audit: sink } });
    const controller = new AbortController();
    controller.abort();
    await expect(gate.run(gateRequest({ signal: controller.signal }))).rejects.toBeInstanceOf(RequestCancelled);
    expect(leases).toBe(0);
    expect(executor.calls).toEqual([]);
    expect(events.map((event) => event.result)).toEqual(['failed']);
  });
});

describe('a request that is not aborted', () => {
  it('passes its signal to the read and answers as before', async () => {
    const executor = new TestExecutor();
    const { gate } = harness({ executor });
    const controller = new AbortController();
    await expect(gate.run(gateRequest({ signal: controller.signal }))).resolves.toBeDefined();
    expect(executor.calls[0]?.signal).toBe(controller.signal);
  });
});

describe('a grant that lands in the tick of the abort', () => {
  it('is given back once, the read never starts, and the run fails as cancelled', async () => {
    const controller = new AbortController();
    let releases = 0;
    const coordinator: Coordinator = {
      acquireRead: () => {
        controller.abort();
        return Promise.resolve({ status: 'granted', lease: { release: () => (releases++, Promise.resolve()) } });
      },
    };
    const executor = new TestExecutor();
    const { gate } = harness({ executor, seams: { coordinator } });
    await expect(gate.run(gateRequest({ signal: controller.signal }))).rejects.toBeInstanceOf(RequestCancelled);
    expect(releases).toBe(1);
    expect(executor.calls).toEqual([]);
  });

  it('is the same when the slot queue answers cancelled', async () => {
    const coordinator: Coordinator = { acquireRead: () => Promise.resolve({ status: 'cancelled' }) };
    const { gate, executor } = harness({ seams: { coordinator } });
    await expect(gate.run(gateRequest({ signal: new AbortController().signal }))).rejects.toBeInstanceOf(RequestCancelled);
    expect(executor.calls).toEqual([]);
  });
});

describe('a request of several pages aborted after the first', () => {
  it('reads no further page and releases its one lease once', async () => {
    const controller = new AbortController();
    let releases = 0;
    let leases = 0;
    const coordinator: Coordinator = {
      acquireRead: () => (leases++, Promise.resolve({ status: 'granted', lease: { release: () => (releases++, Promise.resolve()) } })),
    };
    const executor = new TestExecutor((call) => {
      controller.abort();
      return Promise.resolve({ status: 'rows', rows: Array.from({ length: call.rowLimit - 1 }, () => ({ title: 'x' })) });
    });
    const { gate } = harness({ executor, seams: { coordinator } });
    const signal = controller.signal;
    await expect(gate.runMany([gateRequest({ signal }), gateRequest({ signal }), gateRequest({ signal })])).rejects.toBeInstanceOf(RequestCancelled);
    expect(executor.calls).toHaveLength(1);
    expect(leases).toBe(1);
    expect(releases).toBe(1);
  });

  it('takes no lease and reads nothing when the abort came before the execute stage', async () => {
    const controller = new AbortController();
    controller.abort();
    let leases = 0;
    const coordinator: Coordinator = { acquireRead: () => (leases++, Promise.reject(new Error('not reached'))) };
    const executor = new TestExecutor();
    const { gate } = harness({ executor, seams: { coordinator } });
    await expect(gate.runMany([gateRequest({ signal: controller.signal })])).rejects.toBeInstanceOf(RequestCancelled);
    expect(leases).toBe(0);
    expect(executor.calls).toEqual([]);
  });
});
