import type { AuditEvent, AuditSink, MountedAuditSink } from '@neburyx/contracts';
import { describe, expect, it, vi } from 'vitest';
import { communityAudit } from '../seams/community-seams.js';
import { stopQueues, wireAudit } from './wiring.js';

const SETTINGS = { queueSize: 10, retryLimit: 0, retryWaitMs: 10, writeTimeoutMs: 1000 };
const logger = { warn: () => undefined };
const event: AuditEvent = { actorId: 'u-1', actorRole: 'investigator', action: 'graph.expand', result: 'success', traceId: 'tr-1' };

function recorder(): { readonly sink: AuditSink; readonly seen: string[] } {
  const seen: string[] = [];
  return { seen, sink: { record: (recorded) => (seen.push(recorded.action), Promise.resolve()) } };
}

const mountedOf = (sink: AuditSink): MountedAuditSink => ({ sink, close: () => Promise.resolve() });

describe('where the audit events go', () => {
  it('sends ordinary events through the queue to the built-in store, and privileged events straight to it', async () => {
    const store = recorder();
    const wiring = wireAudit({ sinkNames: ['postgres'], mounted: mountedOf(store.sink), storeInUse: true, settings: SETTINGS, logger });
    expect(wiring.privilegedAudit).toBe(store.sink);
    await wiring.audit?.record(event);
    await vi.waitFor(() => expect(store.seen).toEqual(['graph.expand']));
  });

  it('sends ordinary events to stdout only when stdout alone is chosen, and privileged events still to the store', async () => {
    const store = recorder();
    const out = recorder();
    const wiring = wireAudit({ sinkNames: ['stdout'], mounted: mountedOf(store.sink), storeInUse: true, settings: SETTINGS, logger, stdout: out.sink });
    await wiring.audit?.record(event);
    await vi.waitFor(() => expect(out.seen).toEqual(['graph.expand']));
    expect(store.seen).toEqual([]);
    expect(wiring.privilegedAudit).toBe(store.sink);
  });

  it('sends each ordinary event to both sinks when both are chosen', async () => {
    const store = recorder();
    const out = recorder();
    const wiring = wireAudit({ sinkNames: ['postgres', 'stdout'], mounted: mountedOf(store.sink), storeInUse: true, settings: SETTINGS, logger, stdout: out.sink });
    await wiring.audit?.record(event);
    await vi.waitFor(() => expect([store.seen, out.seen]).toEqual([['graph.expand'], ['graph.expand']]));
  });

  it('keeps a privileged event off stdout and on the store whatever the choice, and refuses nothing when the store is down for ordinary events', async () => {
    const down: AuditSink = { record: () => Promise.reject(new Error('down')) };
    const out = recorder();
    const wiring = wireAudit({ sinkNames: ['postgres', 'stdout'], mounted: mountedOf(down), storeInUse: true, settings: SETTINGS, logger, stdout: out.sink });
    await expect(wiring.privilegedAudit?.record(event)).rejects.toThrow('down');
    await expect(wiring.audit?.record(event)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(out.seen).toEqual(['graph.expand']));
    expect(wiring.queue?.counts().failed).toBeGreaterThanOrEqual(0);
  });

  it('is the Community default when the store is not in use and stdout is not chosen, with a mounted extension or without one', () => {
    const store = recorder();
    expect(wireAudit({ sinkNames: ['postgres'], mounted: undefined, storeInUse: false, settings: SETTINGS, logger })).toEqual({ queue: undefined, audit: undefined, privilegedAudit: communityAudit });
    const withExtension = wireAudit({ sinkNames: ['postgres'], mounted: mountedOf(store.sink), storeInUse: false, settings: SETTINGS, logger });
    expect(withExtension.audit).toBeUndefined();
    expect(withExtension.privilegedAudit).toBe(communityAudit);
    expect(withExtension.queue).toBeDefined();
  });

  it('writes the ordinary events of a Community build to stdout when stdout is chosen, with no store', async () => {
    const out = recorder();
    const wiring = wireAudit({ sinkNames: ['stdout'], mounted: undefined, storeInUse: false, settings: SETTINGS, logger, stdout: out.sink });
    await wiring.audit?.record(event);
    await vi.waitFor(() => expect(out.seen).toEqual(['graph.expand']));
    expect(wiring.privilegedAudit).toBe(communityAudit);
  });
});

describe('stopping every queue', () => {
  it('waits for all of them under one deadline and not for each in turn, and ignores a queue that was never built', async () => {
    vi.useFakeTimers();
    try {
      const stops: number[] = [];
      const slow = { stop: (limit: number) => new Promise<void>((resolve) => setTimeout(() => (stops.push(limit), resolve()), limit)) };
      const done = stopQueues([slow, undefined, slow, slow], 5000);
      await vi.advanceTimersByTimeAsync(5000);
      await done;
      expect(stops).toEqual([5000, 5000, 5000]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the privileged member in every configuration', () => {
  const MOUNTED = [true, false];
  const SINKS = [['postgres'], ['stdout'], ['postgres', 'stdout']] as const;
  const IN_USE = [true, false];
  const cases = SINKS.flatMap((sinkNames) => MOUNTED.flatMap((mounted) => IN_USE.map((storeInUse) => ({ sinkNames, mounted, storeInUse }))));

  it.each(cases)('is never the queue and never writes to stdout: sinks $sinkNames, store mounted $mounted, store in use $storeInUse', async ({ sinkNames, mounted, storeInUse }) => {
    const store = recorder();
    const out = recorder();
    const wiring = wireAudit({ sinkNames, mounted: mounted ? mountedOf(store.sink) : undefined, storeInUse, settings: SETTINGS, logger, stdout: out.sink });
    expect(wiring.privilegedAudit).not.toBe(wiring.queue?.sink);
    await wiring.privilegedAudit.record(event);
    await vi.waitFor(() => expect(out.seen).toEqual([]));
    expect(store.seen).toEqual(mounted && storeInUse ? ['graph.expand'] : []);
  });
});
