import { describe, expect, it, vi } from 'vitest';
import { AppError, RequestCancelled } from '../errors.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Coordinator } from '../seams/seams.js';
import { neo4jError } from '../testing/fake-source-driver.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { fakeClock, gateRequest, harness, testCatalog, TestExecutor } from '../testing/gate.js';
import { NOW, rig, useClock } from '../testing/source-rig.js';
import { assembleGate } from './assemble.js';
import { acquireLease } from './execute.js';
import { EMPTY_ALLOWLIST, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { EMPTY_MODEL } from './normalize/model.js';
import type { GateContext } from './types.js';
import { DEFAULT_BUDGETS } from './budgets.js';

const SOURCE_MS = 5000;
const REQUEST_MS = 10_000;
const budgets = { ...DEFAULT_BUDGETS, timeoutMs: SOURCE_MS, requestTimeoutMs: REQUEST_MS };

const contextOf = (): GateContext => ({ traceId: 'tr-limit', principal: LOCAL_PRINCIPAL, system: false, role: 'data', sourceId: 'alpha', budgets, allowlist: EMPTY_ALLOWLIST, policyVersion: 'none', mask: false, model: EMPTY_MODEL, deadlineAt: 0 });

async function limitOf(promise: Promise<unknown>): Promise<unknown> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof AppError) || error.code !== 'QUERY_TIMEOUT') throw new Error('expected QUERY_TIMEOUT');
  return (error.details as { readonly timeoutMs?: number } | undefined)?.timeoutMs;
}

describe('the limit a QUERY_TIMEOUT names, with a fake executor', () => {
  it('is the source’s timeout when the server stopped a read that had the whole timeout', async () => {
    const { gate } = harness({ executor: new TestExecutor(() => Promise.resolve({ status: 'timeout' })), budgetsFor: () => budgets });
    expect(await limitOf(gate.run(gateRequest()))).toBe(SOURCE_MS);
  });

  it('is the request limit when the deadline had passed before a lease could be asked for', async () => {
    const coordinator: Coordinator = { acquireRead: () => Promise.reject(new Error('not reached')) };
    const context = { ...contextOf(), deadlineAt: 1_000_000 };
    expect(await limitOf(acquireLease({ coordinator, clock: () => 1_000_000, logger: { warn: () => undefined } }, context))).toBe(REQUEST_MS);
  });

  it('is the request limit when the deadline passed while the read waited for its slot', async () => {
    const clock = fakeClock();
    const events: AuditEvent[] = [];
    const coordinator: Coordinator = {
      acquireRead: () => {
        clock.advance(REQUEST_MS);
        return Promise.resolve({ status: 'granted', lease: { release: () => Promise.resolve() } });
      },
    };
    const { gate, executor } = harness({
      clock: clock.now,
      budgetsFor: () => budgets,
      seams: { coordinator, audit: { record: (event) => Promise.resolve(void events.push(event)) } },
    });
    expect(await limitOf(gate.run(gateRequest()))).toBe(REQUEST_MS);
    expect(executor.calls).toEqual([]);
    expect(events.map((event) => event.result)).toEqual(['failed']);
  });

  it('is the request limit when the read started with less than the source’s timeout left and the adapter stopped it', async () => {
    const clock = fakeClock();
    const coordinator: Coordinator = {
      acquireRead: () => {
        clock.advance(REQUEST_MS - SOURCE_MS + 1000);
        return Promise.resolve({ status: 'granted', lease: { release: () => Promise.resolve() } });
      },
    };
    const executor = new TestExecutor(() => Promise.resolve({ status: 'timeout' }));
    const { gate } = harness({ clock: clock.now, budgetsFor: () => budgets, seams: { coordinator }, executor });
    expect(await limitOf(gate.run(gateRequest()))).toBe(REQUEST_MS);
    expect(executor.calls[0]?.timeoutMs).toBe(SOURCE_MS);
  });

  it('is the source’s timeout when exactly the timeout was left', async () => {
    const clock = fakeClock();
    const coordinator: Coordinator = {
      acquireRead: () => {
        clock.advance(REQUEST_MS - SOURCE_MS);
        return Promise.resolve({ status: 'granted', lease: { release: () => Promise.resolve() } });
      },
    };
    const { gate } = harness({ clock: clock.now, budgetsFor: () => budgets, seams: { coordinator }, executor: new TestExecutor(() => Promise.resolve({ status: 'timeout' })) });
    expect(await limitOf(gate.run(gateRequest()))).toBe(SOURCE_MS);
  });
});

describe('the limit a QUERY_TIMEOUT names, with the real executor over a fake source', () => {
  const mapping = mappingOf(sourceWith('alpha'));
  const aheadBy = (ms: number): Coordinator => {
    const seams = communitySeams();
    return {
      acquireRead: async (request) => {
        const admission = await seams.coordinator.acquireRead(request);
        vi.setSystemTime(Date.now() + ms);
        return admission;
      },
    };
  };
  const gateOver = (behaviour: Parameters<typeof rig>[0], coordinator: Coordinator) => {
    const { executor } = rig(behaviour, mapping.sources);
    const seams = communitySeams();
    return assembleGate({ mapping, seams: { policy: seams.policy, coordinator, audit: seams.audit }, executor, logger: { warn: () => undefined }, clock: () => Date.now(), catalog: testCatalog() }).gate;
  };
  const request = () => gateRequest({ sourceId: 'alpha' });

  it('names the source’s timeout when the server stops a read that had the whole timeout', async () => {
    useClock();
    const gate = gateOver({ streamError: neo4jError('Neo.ClientError.Transaction.TransactionTimedOut') }, aheadBy(0));
    expect(await limitOf(gate.run(request()))).toBe(SOURCE_MS);
  });

  it('names the request limit when the server stops a transaction opened with less time than the timeout', async () => {
    useClock();
    const gate = gateOver({ streamError: neo4jError('Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration') }, aheadBy(6000));
    expect(await limitOf(gate.run(request()))).toBe(REQUEST_MS);
  });

  it('names the request limit when the adapter’s guard fires at a deadline nearer than the source’s timeout while the query still runs', async () => {
    useClock();
    const gate = gateOver({ manual: true }, aheadBy(6000));
    const answer = limitOf(gate.run(request()));
    await vi.advanceTimersByTimeAsync(4000);
    expect(await answer).toBe(REQUEST_MS);
    expect(Date.now()).toBe(NOW + 10_000);
  });
});

describe('an abort and a timeout in a fixed order, with the real executor over a fake source', () => {
  const mapping = mappingOf(sourceWith('alpha'));
  const flush = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };

  function rigged() {
    useClock();
    const { executor, fake } = rig({ manual: true }, mapping.sources);
    const seams = communitySeams();
    const events: AuditEvent[] = [];
    const leases = { taken: 0, released: 0 };
    const coordinator: Coordinator = {
      acquireRead: async (request) => {
        const admission = await seams.coordinator.acquireRead(request);
        if (admission.status !== 'granted') return admission;
        leases.taken += 1;
        return {
          status: 'granted',
          lease: {
            release: () => {
              leases.released += 1;
              return admission.lease.release();
            },
          },
        };
      },
    };
    const { gate } = assembleGate({
      mapping,
      seams: { policy: seams.policy, coordinator, audit: { record: (event) => Promise.resolve(void events.push(event)) } },
      executor,
      logger: { warn: () => undefined },
      clock: () => Date.now(),
      catalog: testCatalog(),
    });
    const session = () => fake.drivers[0]?.sessions[0];
    return { gate, events, leases, session };
  }

  it('abort first, then the timeout: cancelled, the session closed once with no rollback, one cancelled audit event, the lease released once', async () => {
    const { gate, events, leases, session } = rigged();
    const controller = new AbortController();
    const answer = gate.run(gateRequest({ sourceId: 'alpha', signal: controller.signal })).then(
      () => 'answered',
      (caught: unknown) => caught,
    );
    await flush();
    controller.abort();
    expect(await answer).toBeInstanceOf(RequestCancelled);
    session()?.observer?.onError(neo4jError('Neo.ClientError.Transaction.TransactionTimedOut'));
    await vi.advanceTimersByTimeAsync(REQUEST_MS);
    expect(session()?.closeCalls).toBe(1);
    expect(session()?.rollbackCalls).toBe(0);
    expect(events.map((event) => [event.result, event.detail])).toEqual([['failed', { reason: 'cancelled' }]]);
    expect(leases).toEqual({ taken: 1, released: 1 });
  });

  it('timeout first (the guard at the deadline, the read having had the whole timeout), then the abort: QUERY_TIMEOUT naming the source’s timeout, one failed audit event with the reason timeout, no second close, the lease released once', async () => {
    const { gate, events, leases, session } = rigged();
    const controller = new AbortController();
    const answer = limitOf(gate.run(gateRequest({ sourceId: 'alpha', signal: controller.signal })));
    await vi.advanceTimersByTimeAsync(REQUEST_MS);
    expect(await answer).toBe(SOURCE_MS);
    const closes = session()?.closeCalls;
    controller.abort();
    await flush();
    expect(session()?.closeCalls).toBe(closes);
    expect(closes).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.result).toBe('failed');
    expect(events[0]?.detail).toEqual({ reason: 'timeout' });
    expect(leases).toEqual({ taken: 1, released: 1 });
  });
});
