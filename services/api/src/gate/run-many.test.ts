import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Coordinator } from '../seams/seams.js';
import { fakeClock, gateRequest, harness, testCatalog, testTemplate, TestExecutor } from '../testing/gate.js';
import type { ExecuteOutcome } from './executor.js';

const rows = (count: number): ExecuteOutcome => ({ status: 'rows', rows: Array.from({ length: count }, (_, index) => ({ title: `item ${index + 1}` })) });

function rig(options: { readonly answer?: (call: number) => ExecuteOutcome; readonly template?: Parameters<typeof testTemplate>[0]; readonly redact?: Parameters<typeof harness>[0] extends infer O ? (O extends { redact?: infer R } ? R : never) : never; readonly refuse?: 'busy' | 'unavailable'; readonly clock?: () => number } = {}) {
  let call = 0;
  const executor = new TestExecutor(() => Promise.resolve((options.answer ?? (() => rows(1)))(call++)));
  const lease = { held: 0, acquired: 0 };
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const coordinator: Coordinator = {
    acquireRead: async (request) => {
      if (options.refuse !== undefined) return { status: options.refuse };
      const admission = await defaults.coordinator.acquireRead(request);
      if (admission.status !== 'granted') return admission;
      lease.held += 1;
      lease.acquired += 1;
      return { status: 'granted', lease: { release: async () => { lease.held -= 1; await admission.lease.release(); } } };
    },
  } as Coordinator;
  const parts = harness({
    catalog: testCatalog([testTemplate(options.template)]),
    executor,
    seams: { coordinator, audit: { record: (event) => (events.push(event), Promise.resolve()) } },
    ...(options.redact === undefined ? {} : { redact: options.redact }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  return { ...parts, lease, events };
}

const request = (extra: Record<string, unknown> = {}) => gateRequest({ params: { key: 'k1' }, ...extra });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
}

describe('a request that reads several pages under one lease', () => {
  it('reads them one after another under one lease, answers every page and writes one audit event', async () => {
    const { gate, lease, events } = rig();
    const pages = await gate.runMany([request(), request(), request()]);
    expect(pages).toHaveLength(3);
    expect(lease.acquired).toBe(1);
    expect(lease.held).toBe(0);
    expect(events).toHaveLength(1);
  });

  it('answers the failure and no page when the second read fails, and releases the lease', async () => {
    const { gate, lease, events } = rig({ answer: (call) => (call === 1 ? { status: 'timeout' } : rows(1)) });
    expect(await codeOf(gate.runMany([request(), request()]))).toBe('QUERY_TIMEOUT');
    expect(lease.held).toBe(0);
    expect(events).toEqual([expect.objectContaining({ result: 'failed' })]);
  });

  it('answers the failure when a normalize stage fails, and releases the lease', async () => {
    const { gate, lease } = rig({ template: { normalize: () => { throw new Error('the page cannot be shaped'); } } });
    expect(await codeOf(gate.runMany([request(), request()]))).toBe('INTERNAL_ERROR');
    expect(lease.held).toBe(0);
  });

  it('answers the failure when a redact stage fails, and releases the lease', async () => {
    const { gate, lease } = rig({ redact: () => { throw new Error('the page cannot be masked'); } });
    expect(await codeOf(gate.runMany([request(), request()]))).toBe('INTERNAL_ERROR');
    expect(lease.held).toBe(0);
  });

  it.each([['busy', 'SOURCE_BUSY'], ['unavailable', 'SOURCE_UNAVAILABLE']] as const)('answers %s as %s when no lease is granted, and reads nothing', async (refuse, code) => {
    const { gate, executor, lease } = rig({ refuse });
    expect(await codeOf(gate.runMany([request(), request()]))).toBe(code);
    expect(executor.calls).toEqual([]);
    expect(lease.acquired).toBe(0);
  });

  it('counts all the pages against one deadline: a page that starts after it answers QUERY_TIMEOUT, and the whole request fails', async () => {
    const clock = fakeClock();
    const { gate, lease } = rig({ clock: clock.now, answer: (call) => { if (call === 0) clock.advance(60_000); return rows(1); } });
    expect(await codeOf(gate.runMany([request(), request()]))).toBe('QUERY_TIMEOUT');
    expect(lease.held).toBe(0);
  });

  it('refuses, before any read, requests that name different templates, sources, people or masking, so one authorize stage covers them all', async () => {
    const { gate, executor } = rig();
    for (const other of [{ templateId: 'other' }, { sourceId: 'source-b' }, { mask: true }]) {
      expect(await codeOf(gate.runMany([request(), request(other)]))).toBe('INVALID_REQUEST');
    }
    expect(executor.calls).toEqual([]);
  });
});
