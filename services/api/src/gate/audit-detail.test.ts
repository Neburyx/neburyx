import { describe, expect, it } from 'vitest';
import type { AuditEvent, Coordinator } from '../seams/seams.js';
import { gateRequest, harness, TestExecutor } from '../testing/gate.js';
import type { ExecuteOutcome } from './executor.js';

async function auditOf(answer: ExecuteOutcome, coordinator?: Coordinator, signal?: AbortSignal): Promise<readonly AuditEvent[]> {
  const events: AuditEvent[] = [];
  const parts = harness({
    executor: new TestExecutor(() => Promise.resolve(answer)),
    seams: { audit: { record: (event) => (events.push(event), Promise.resolve()) }, ...(coordinator === undefined ? {} : { coordinator }) },
  });
  await parts.gate.run(gateRequest(signal === undefined ? {} : { signal })).catch(() => undefined);
  return events;
}

describe('the audit event of a read that ends in a timeout', () => {
  it('is failed, with the reason timeout', async () => {
    const [event, ...rest] = await auditOf({ status: 'timeout' });
    expect(rest).toEqual([]);
    expect(event).toMatchObject({ result: 'failed', detail: { reason: 'timeout' } });
  });

  it('holds no address, query or value', async () => {
    const [event] = await auditOf({ status: 'timeout' });
    expect(Object.keys(event ?? {}).sort()).toEqual(['action', 'actorId', 'actorRole', 'detail', 'result', 'sourceId', 'traceId']);
    expect(event?.detail).toEqual({ reason: 'timeout' });
  });

  it('is still cancelled when the person cancelled, and has no detail for other failures', async () => {
    const controller = new AbortController();
    const [cancelled] = await auditOf({ status: 'cancelled' }, undefined, controller.signal);
    expect(cancelled).toMatchObject({ result: 'failed', detail: { reason: 'cancelled' } });
    const [unreachable] = await auditOf({ status: 'unavailable', reason: 'unreachable' });
    expect(unreachable?.detail).toBeUndefined();
    const refusing: Coordinator = { acquireRead: () => Promise.resolve({ status: 'unavailable', reason: 'repeated-timeouts', retryAfterMs: 1000 }) };
    const [refused] = await auditOf({ status: 'timeout' }, refusing);
    expect(refused).toMatchObject({ result: 'failed' });
    expect(refused?.detail).toBeUndefined();
    const busy: Coordinator = { acquireRead: () => Promise.resolve({ status: 'busy' }) };
    expect((await auditOf({ status: 'timeout' }, busy))[0]?.detail).toBeUndefined();
  });
});
