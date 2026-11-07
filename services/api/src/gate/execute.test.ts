import { describe, expect, it } from 'vitest';
import type { AuditEvent, Coordinator } from '../seams/seams.js';
import { DEFAULT_BUDGETS } from './budgets.js';
import { fakeClock, gateRequest, harness, rowsOf, testCatalog, testTemplate, TestExecutor } from '../testing/gate.js';

describe('an executor that reports a timeout', () => {
  it('gives QUERY_TIMEOUT and is called exactly once', async () => {
    const executor = new TestExecutor(() => Promise.resolve({ status: 'timeout' }));
    const { gate } = harness({ executor });
    await expect(gate.run(gateRequest())).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
    expect(executor.calls).toHaveLength(1);
  });
});

describe('a request whose deadline has passed before execute', () => {
  it('gives QUERY_TIMEOUT, calls no executor and takes no lease', async () => {
    const clock = fakeClock();
    let leases = 0;
    const coordinator: Coordinator = { acquireRead: () => (leases++, Promise.reject(new Error('not reached'))) };
    const { gate, executor } = harness({
      clock: clock.now,
      seams: { coordinator },
      budgetsFor: () => ({ ...DEFAULT_BUDGETS, requestTimeoutMs: 0 }),
    });
    await expect(gate.run(gateRequest())).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
    expect(executor.calls).toEqual([]);
    expect(leases).toBe(0);
  });

  it.each([
    ['exactly at the deadline', 0],
    ['beyond the deadline', 5],
  ])('gives QUERY_TIMEOUT when admission finishes %s, with no executor call, one lease release and audit failed', async (_name, beyond) => {
    const clock = fakeClock();
    const events: AuditEvent[] = [];
    let releases = 0;
    const coordinator: Coordinator = {
      acquireRead: () => {
        clock.advance(DEFAULT_BUDGETS.requestTimeoutMs + beyond);
        return Promise.resolve({ status: 'granted', lease: { release: () => (releases++, Promise.resolve()) } });
      },
    };
    const { gate, executor } = harness({
      clock: clock.now,
      seams: { coordinator, audit: { record: (event) => Promise.resolve(void events.push(event)) } },
    });
    await expect(gate.run(gateRequest())).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
    expect(executor.calls).toEqual([]);
    expect(releases).toBe(1);
    expect(events.map((event) => event.result)).toEqual(['failed']);
  });

  it('still runs when the deadline is one millisecond away', async () => {
    const clock = fakeClock();
    const { gate, executor } = harness({ clock: clock.now, budgetsFor: () => ({ ...DEFAULT_BUDGETS, requestTimeoutMs: 1 }) });
    await gate.run(gateRequest());
    expect(executor.calls).toHaveLength(1);
  });
});

describe('an executor that fails', () => {
  it('reporting the source unavailable gives SOURCE_UNAVAILABLE', async () => {
    const executor = new TestExecutor(() => Promise.resolve({ status: 'unavailable', reason: 'unreachable' }));
    const { gate } = harness({ executor });
    await expect(gate.run(gateRequest())).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  });

  it('throwing query-like text gives INTERNAL_ERROR and neither the error nor the log holds that text', async () => {
    const text = 'MATCH (n:Secret) RETURN n.ssn';
    const executor = new TestExecutor(() => Promise.reject(new Error(text)));
    const { gate, logs } = harness({ executor });
    const error = await gate.run(gateRequest()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(error)).not.toContain(text);
    expect(String(error)).not.toContain(text);
    expect(JSON.stringify(logs)).not.toContain(text);
  });
});

describe('the executor call', () => {
  it('holds read access mode, the source timeout, the page limit plus one, the request deadline and the trace ID', async () => {
    const clock = fakeClock(42_000);
    const { gate, executor } = harness({ clock: clock.now, budgetsFor: () => ({ ...DEFAULT_BUDGETS, timeoutMs: 3000, maxPage: 20, requestTimeoutMs: 8000, countCap: 500 }) });
    await gate.run(gateRequest({ limit: 12, traceId: 'tr-call-1' }));
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toMatchObject({
      accessMode: 'READ',
      timeoutMs: 3000,
      rowLimit: 13,
      deadlineAt: 50_000,
      traceId: 'tr-call-1',
      sourceId: 'source-a',
      templateId: 'test-read',
      templateVersion: '1',
    });
  });
});

describe('the rows an executor returns', () => {
  it('one more than the limit give a page of exactly the limit with more available', async () => {
    const { gate } = harness({ catalog: testCatalog([testTemplate({ paged: true })]), executor: new TestExecutor(() => Promise.resolve(rowsOf(11))) });
    const page = await gate.run(gateRequest({ limit: 10 }));
    expect(page.items).toHaveLength(10);
    expect(page.hasMore).toBe(true);
  });

  it('one more than the limit of a template that is not paged and declares no cut meaning fail INTERNAL_ERROR tagged read-cut, with no row', async () => {
    const { gate } = harness({ executor: new TestExecutor(() => Promise.resolve(rowsOf(11))) });
    await expect(gate.run(gateRequest({ limit: 10 }))).rejects.toMatchObject({ code: 'INTERNAL_ERROR', reason: 'read-cut' });
  });

  it.each([10, 3, 0])('%s rows with a limit of 10 give no more', async (count) => {
    const { gate } = harness({ executor: new TestExecutor(() => Promise.resolve(rowsOf(count))) });
    const page = await gate.run(gateRequest({ limit: 10 }));
    expect(page.items).toHaveLength(count);
    expect(page.hasMore).toBe(false);
  });
});
