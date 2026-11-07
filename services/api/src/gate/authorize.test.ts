import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import type { AuditEvent, AuditSink, Coordinator, PolicyProvider, ReadAccessRequest, ReadAdmission } from '../seams/seams.js';
import { gateRequest, harness, LOCAL_PRINCIPAL, SOURCE_A, TestExecutor, rowsOf } from '../testing/gate.js';

const denying: PolicyProvider = { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'no grant for this source' }) };

function recordingCoordinator(admission: () => ReadAdmission): Coordinator & { readonly requests: ReadAccessRequest[] } {
  const requests: ReadAccessRequest[] = [];
  return { requests, acquireRead: (request) => (requests.push(request), Promise.resolve(admission())) };
}

function lease(log: string[]): ReadAdmission {
  return { status: 'granted', lease: { release: () => Promise.resolve(void log.push('release')) } };
}

describe('a policy that denies', () => {
  it('gives ACCESS_DENIED with no reason, asks no coordinator, executes nothing and audits denied', async () => {
    const events: AuditEvent[] = [];
    const coordinator = recordingCoordinator(() => ({ status: 'busy' }));
    const audit: AuditSink = { record: (event) => Promise.resolve(void events.push(event)) };
    const { gate, executor } = harness({ seams: { policy: denying, coordinator, audit } });
    const error = await gate.run(gateRequest()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'ACCESS_DENIED' });
    expect(JSON.stringify(error)).not.toContain('no grant for this source');
    expect(coordinator.requests).toEqual([]);
    expect(executor.calls).toEqual([]);
    expect(events.map((event) => event.result)).toEqual(['denied']);
  });
});

describe('a coordinator that refuses', () => {
  it.each([
    ['busy', 'SOURCE_BUSY'],
    ['unavailable', 'SOURCE_UNAVAILABLE'],
  ] as const)('answering %s gives %s, executes nothing and audits failed', async (status, code) => {
    const events: AuditEvent[] = [];
    const coordinator = recordingCoordinator(() => ({ status }));
    const { gate, executor } = harness({ seams: { coordinator, audit: { record: (event) => Promise.resolve(void events.push(event)) } } });
    await expect(gate.run(gateRequest())).rejects.toMatchObject({ code });
    expect(executor.calls).toEqual([]);
    expect(events.map((event) => event.result)).toEqual(['failed']);
  });
});

describe('the read lease', () => {
  it('is taken before the executor runs and released exactly once after rows', async () => {
    const log: string[] = [];
    const coordinator = recordingCoordinator(() => lease(log));
    const executor = new TestExecutor(() => (log.push('execute'), Promise.resolve(rowsOf(1))));
    const { gate } = harness({ seams: { coordinator }, executor });
    await gate.run(gateRequest());
    expect(log).toEqual(['execute', 'release']);
    expect(coordinator.requests).toEqual([{ principal: LOCAL_PRINCIPAL, sourceId: SOURCE_A, limits: { userConcurrency: 2, sourceConcurrency: 32, queueWaitMs: 2000 }, leaseTtlMs: 15_000 }]);
  });

  it('is released exactly once after a timeout', async () => {
    const log: string[] = [];
    const coordinator = recordingCoordinator(() => lease(log));
    const executor = new TestExecutor(() => (log.push('execute'), Promise.resolve({ status: 'timeout' as const })));
    const { gate } = harness({ seams: { coordinator }, executor });
    await expect(gate.run(gateRequest())).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
    expect(log).toEqual(['execute', 'release']);
  });

  it('is released exactly once after an executor failure', async () => {
    const log: string[] = [];
    const coordinator = recordingCoordinator(() => lease(log));
    const executor = new TestExecutor(() => (log.push('execute'), Promise.reject(new Error('driver exploded'))));
    const { gate } = harness({ seams: { coordinator }, executor });
    await expect(gate.run(gateRequest())).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(log).toEqual(['execute', 'release']);
  });

  it('does not change the outcome of a read when the release fails, and logs without data', async () => {
    const coordinator: Coordinator = {
      acquireRead: () => Promise.resolve({ status: 'granted', lease: { release: () => Promise.reject(new Error('valkey gone')) } }),
    };
    const { gate, logs } = harness({ seams: { coordinator } });
    await expect(gate.run(gateRequest())).resolves.toMatchObject({ hasMore: false });
    expect(logs.map((entry) => entry.fields)).toEqual([{ event: 'gate.lease_release_failed' }]);
  });
});

describe('stubs for the policy provider, the audit sink and the coordinator', () => {
  it('are used together: policy at authorize, the lease before execute, the event at the end', async () => {
    const log: string[] = [];
    const policy: PolicyProvider = {
      authorizeSource: (request) => (log.push(`authorize ${request.principal.id} ${request.sourceId}`), Promise.resolve({ allowed: true })),
    };
    const coordinator = recordingCoordinator(() => (log.push('lease'), lease(log)));
    const audit: AuditSink = { record: (event) => Promise.resolve(void log.push(`audit ${event.result}`)) };
    const executor = new TestExecutor(() => (log.push('execute'), Promise.resolve(rowsOf(1))));
    const { gate } = harness({ seams: { policy, coordinator, audit }, executor });
    await gate.run(gateRequest());
    expect(log).toEqual([`authorize ${LOCAL_PRINCIPAL.id} ${SOURCE_A}`, 'lease', 'execute', 'release', 'audit success']);
  });
});
