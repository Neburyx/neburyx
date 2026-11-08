import { describe, expect, it } from 'vitest';
import { withBreaker } from './breaker.js';
import { createReadSlots } from './read-slots.js';
import type { Coordinator, ReadAccessRequest, ReadAdmission, ReadOutcome, ReadRole } from './seams.js';

const PERSON = { id: 'ana', displayName: 'ana', role: 'investigator' as const };
const RULE = { failures: 3, windowMs: 60_000, cooldownMs: 30_000 };

function rig(rule = RULE) {
  let now = 1_000_000;
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  const slots = createReadSlots();
  let asked = 0;
  const inner: Coordinator = { acquireRead: (request) => (asked += 1, slots.acquireRead(request)) };
  const breaker = withBreaker(inner, {
    clock: () => now,
    setTimer: (run, ms) => {
      const timer = { at: now + ms, run, live: true };
      timers.push(timer);
      return { cancel: () => { timer.live = false; } };
    },
  });
  const advance = (ms: number): void => {
    now += ms;
    for (const timer of timers) if (timer.live && timer.at <= now) { timer.live = false; timer.run(); }
  };
  const ask = (sourceId = 'a', role: ReadRole = 'data', overrides: Partial<ReadAccessRequest> = {}): Promise<ReadAdmission> =>
    breaker.acquireRead({ principal: PERSON, sourceId, limits: { userConcurrency: 8, sourceConcurrency: 8, queueWaitMs: 50 }, role, breaker: rule, leaseTtlMs: 15_000, ...overrides });
  /** Asks, and ends the read with the given outcome. */
  const read = async (outcome: ReadOutcome, sourceId = 'a', role: ReadRole = 'data'): Promise<ReadAdmission> => {
    const admission = await ask(sourceId, role);
    if (admission.status === 'granted') await admission.lease.release(outcome);
    return admission;
  };
  return { ask, read, advance, slots, asked: () => asked };
}

const refusal = (retryAfterMs: number) => ({ status: 'unavailable', reason: 'repeated-timeouts', retryAfterMs });

async function trip(r: ReturnType<typeof rig>, sourceId = 'a'): Promise<void> {
  for (let i = 0; i < 3; i += 1) await r.read('timeout', sourceId);
}

describe('the breaker closed', () => {
  it('opens on the configured number of timeouts within the window, and refuses without asking the slots', async () => {
    const r = rig();
    await r.read('timeout');
    await r.read('timeout');
    const admitted = await r.ask();
    expect(admitted.status).toBe('granted');
    if (admitted.status === 'granted') await admitted.lease.release('answered');
    await r.read('timeout');
    const before = r.asked();
    await expect(r.ask()).resolves.toEqual(refusal(30_000));
    expect(r.asked()).toBe(before);
    expect(r.slots.inspect().sources.size).toBe(0);
  });

  it('is not reset by an answer in between', async () => {
    const r = rig();
    await r.read('timeout');
    await r.read('answered');
    await r.read('timeout');
    await r.read('answered');
    await r.read('timeout');
    await expect(r.ask()).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('never opens when fewer than the number fall within any one window', async () => {
    const r = rig();
    for (let i = 0; i < 10; i += 1) {
      await r.read('timeout');
      r.advance(30_000);
    }
    await expect(r.ask()).resolves.toMatchObject({ status: 'granted' });
  });

  it.each<ReadOutcome>(['other', 'answered'])('does not count a read that ends as %s', async (outcome) => {
    const r = rig();
    for (let i = 0; i < 6; i += 1) await r.read(outcome);
    await expect(r.ask()).resolves.toMatchObject({ status: 'granted' });
  });

  it('counts a release with no outcome as other', async () => {
    const r = rig();
    for (let i = 0; i < 6; i += 1) {
      const admission = await r.ask();
      if (admission.status === 'granted') await admission.lease.release();
    }
    await expect(r.ask()).resolves.toMatchObject({ status: 'granted' });
  });

  it('keeps each source apart', async () => {
    const r = rig();
    await trip(r, 'a');
    await expect(r.ask('a')).resolves.toMatchObject({ status: 'unavailable' });
    await expect(r.ask('b')).resolves.toMatchObject({ status: 'granted' });
  });

  it('refuses at once, not busy, when every slot is held', async () => {
    const r = rig();
    const held = await r.ask('a', 'data', { limits: { userConcurrency: 1, sourceConcurrency: 1, queueWaitMs: 50 } });
    await trip(r);
    await expect(r.ask('a', 'data', { limits: { userConcurrency: 1, sourceConcurrency: 1, queueWaitMs: 5000 } })).resolves.toMatchObject({ status: 'unavailable' });
    if (held.status === 'granted') await held.lease.release('answered');
  });

  it('counts the timeouts of index and background reads while closed', async () => {
    const r = rig();
    await r.read('timeout', 'a', 'index');
    await r.read('timeout', 'a', 'background');
    await r.read('timeout', 'a', 'index');
    await expect(r.ask()).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('ignores a release from a lease granted before the breaker opened', async () => {
    const r = rig();
    const early = await r.ask();
    await trip(r);
    if (early.status === 'granted') await early.lease.release('timeout');
    r.advance(30_000);
    const trial = await r.ask();
    expect(trial.status).toBe('granted');
  });

  it('lets a request without a rule straight through', async () => {
    const r = rig();
    for (let i = 0; i < 5; i += 1) {
      const admission = await r.ask('a', 'data', { breaker: undefined });
      if (admission.status === 'granted') await admission.lease.release('timeout');
    }
    await expect(r.ask('a', 'data', { breaker: undefined })).resolves.toMatchObject({ status: 'granted' });
  });
});

describe('the breaker open and half-open', () => {
  it('refuses with the time left of the cool-down, rounded up, at least 1', async () => {
    const r = rig();
    await trip(r);
    r.advance(10_500);
    await expect(r.ask()).resolves.toEqual(refusal(19_500));
    r.advance(19_499);
    await expect(r.ask()).resolves.toEqual(refusal(1));
  });

  it('admits exactly one trial when two reads arrive together, and refuses the other with the trial time left', async () => {
    const r = rig();
    await trip(r);
    r.advance(30_000);
    const [first, second] = await Promise.all([r.ask(), r.ask()]);
    expect(first.status).toBe('granted');
    expect(second).toEqual(refusal(15_000));
  });

  it('closes on a trial that answers, and forgets the timeouts', async () => {
    const r = rig();
    await trip(r);
    r.advance(30_000);
    await r.read('answered');
    await expect(r.ask()).resolves.toMatchObject({ status: 'granted' });
    await r.read('timeout');
    await r.read('timeout');
    await expect(r.ask()).resolves.toMatchObject({ status: 'granted' });
  });

  it('opens again for a full cool-down when the trial times out', async () => {
    const r = rig();
    await trip(r);
    r.advance(30_000);
    await r.read('timeout');
    await expect(r.ask()).resolves.toEqual(refusal(30_000));
  });

  it('decides nothing when the trial ends as other, and the next read is the trial', async () => {
    const r = rig();
    await trip(r);
    r.advance(30_000);
    await r.read('other');
    const next = await r.ask();
    expect(next.status).toBe('granted');
    await expect(r.ask()).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('frees the marker when the slots answer the trial busy', async () => {
    const r = rig();
    const holding = await r.ask('a', 'data', { limits: { userConcurrency: 1, sourceConcurrency: 1, queueWaitMs: 5 } });
    await trip(r);
    r.advance(30_000);
    await expect(r.ask('a', 'data', { limits: { userConcurrency: 1, sourceConcurrency: 1, queueWaitMs: 5 }, signal: AbortSignal.abort() })).resolves.toEqual({ status: 'cancelled' });
    if (holding.status === 'granted') await holding.lease.release('answered');
    await expect(r.ask()).resolves.toMatchObject({ status: 'granted' });
  });

  it('never makes a ping the trial, but lets an index read through without deciding', async () => {
    const r = rig();
    await trip(r);
    r.advance(30_000);
    await expect(r.ask('a', 'background')).resolves.toMatchObject({ status: 'unavailable' });
    const index = await r.ask('a', 'index');
    expect(index.status).toBe('granted');
    if (index.status === 'granted') await index.lease.release('answered');
    // the index read did not close it: the data read is still the trial
    const data = await r.ask('a', 'data');
    expect(data.status).toBe('granted');
    await expect(r.ask('a', 'data')).resolves.toMatchObject({ status: 'unavailable' });
    if (data.status === 'granted') await data.lease.release('answered');
    await expect(r.ask('a', 'background')).resolves.toMatchObject({ status: 'granted' });
  });

  it('frees the trial when its lease is never released, and ignores its late release', async () => {
    const r = rig();
    await trip(r);
    r.advance(30_000);
    const lost = await r.ask();
    await expect(r.ask()).resolves.toMatchObject({ status: 'unavailable' });
    r.advance(15_000);
    const next = await r.ask();
    expect(next.status).toBe('granted');
    if (lost.status === 'granted') await lost.lease.release('answered');
    // the late release closed nothing: the new trial is still running
    await expect(r.ask()).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('leaves nothing held after a trial', async () => {
    const r = rig();
    await trip(r);
    r.advance(30_000);
    await r.read('answered');
    expect(r.slots.inspect().sources.size).toBe(0);
    expect(r.slots.inspect().users.size).toBe(0);
  });
});
