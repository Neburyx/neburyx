import { describe, expect, it } from 'vitest';
import { createCheckRunner, type HeavyCheck } from './check-runner.js';

const WORKER = new URL('./check-worker.ts', import.meta.url);
const SLOW_MODULE = new URL('./testing/slow-check.mjs', import.meta.url).href;

interface Echo {
  readonly echoed: number;
}

const parseEcho = (value: unknown): Echo | undefined => (typeof value === 'object' && value !== null && 'echoed' in value && typeof value.echoed === 'number' ? { echoed: value.echoed } : undefined);

function checkOf(name: string, exportName: string, inline: (input: { readonly ms: number }) => Echo): HeavyCheck<{ readonly ms: number }, Echo> {
  return { name, inline, module: { url: SLOW_MODULE, exportName }, parse: parseEcho };
}

/** A clock that the inline run moves by `cost`, so that a check measures as slow or fast without being so. */
function steppedClock() {
  let now = 0;
  return { clock: () => now, advance: (ms: number) => void (now += ms) };
}

/** The longest gap between two ticks of the main thread's timer while `work` runs. */
async function longestGap(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let longest = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 5);
  try {
    await work();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    clearInterval(timer);
  }
  return longest;
}

describe('a reply check that measures slow', () => {
  it('runs in place the first time and in a worker thread once it has measured over the threshold, and the main thread stays free', async () => {
    const stepped = steppedClock();
    const runner = createCheckRunner({ thresholdMs: 50, clock: stepped.clock, workerUrl: WORKER });
    let inline = 0;
    const check = checkOf('slow', 'slow', () => (inline++, stepped.advance(200), { echoed: 0 }));
    expect(await runner.run(check, { ms: 0 }, { timeoutMs: 5000 })).toEqual({ status: 'done', value: { echoed: 0 } });
    expect(inline).toBe(1);
    const gap = await longestGap(async () => expect(await runner.run(check, { ms: 400 }, { timeoutMs: 5000 })).toEqual({ status: 'done', value: { echoed: 400 } }));
    expect(inline).toBe(1);
    expect(gap).toBeLessThan(200);
  });

  it('blocks the main thread when the same work runs in place, which is what the worker avoids', async () => {
    const runner = createCheckRunner({ thresholdMs: 50, workerUrl: WORKER });
    const check = checkOf('slow-inline', 'slow', ({ ms }) => {
      const until = Date.now() + ms;
      while (Date.now() < until);
      return { echoed: ms };
    });
    const gap = await longestGap(async () => void (await runner.run(check, { ms: 300 }, { timeoutMs: 5000 })));
    expect(gap).toBeGreaterThanOrEqual(250);
  });

  it('runs in place again once a worker run measures under the threshold, and keeps one measurement per check', async () => {
    const stepped = steppedClock();
    const runner = createCheckRunner({ thresholdMs: 50, clock: stepped.clock, workerUrl: WORKER });
    let inline = 0;
    const check = checkOf('recovers', 'slow', () => (inline++, stepped.advance(200), { echoed: 0 }));
    await runner.run(check, { ms: 0 }, { timeoutMs: 5000 });
    await runner.run(check, { ms: 1 }, { timeoutMs: 5000 });
    expect(inline).toBe(1);
    await runner.run(check, { ms: 1 }, { timeoutMs: 5000 });
    expect(inline).toBe(2);
    const other = checkOf('another', 'slow', () => (inline++, { echoed: 1 }));
    await runner.run(other, { ms: 0 }, { timeoutMs: 5000 });
    expect(inline).toBe(3);
  });

  async function slowCheck(exportName: string, runnerOptions: { workerUrl?: URL } = {}) {
    const stepped = steppedClock();
    const runner = createCheckRunner({ thresholdMs: 50, clock: stepped.clock, workerUrl: runnerOptions.workerUrl ?? WORKER });
    const check = checkOf(`slow-${exportName}`, exportName, () => (stepped.advance(200), { echoed: 0 }));
    await runner.run(check, { ms: 0 }, { timeoutMs: 5000 });
    return { runner, check };
  }

  it('refuses, and does not hang or throw, when the worker fails', async () => {
    const { runner, check } = await slowCheck('fails');
    expect(await runner.run(check, { ms: 0 }, { timeoutMs: 5000 })).toEqual({ status: 'refused', reason: 'worker-failed' });
  });

  it('refuses when the check named is not in the module', async () => {
    const { runner, check } = await slowCheck('missing');
    expect(await runner.run(check, { ms: 0 }, { timeoutMs: 5000 })).toEqual({ status: 'refused', reason: 'worker-failed' });
  });

  it('refuses when the worker sends back something the check does not read', async () => {
    const stepped = steppedClock();
    const runner = createCheckRunner({ thresholdMs: 50, clock: stepped.clock, workerUrl: WORKER });
    const check: HeavyCheck<{ readonly ms: number }, Echo> = { name: 'unreadable', inline: () => (stepped.advance(200), { echoed: 0 }), module: { url: SLOW_MODULE, exportName: 'slow' }, parse: () => undefined };
    await runner.run(check, { ms: 0 }, { timeoutMs: 5000 });
    expect(await runner.run(check, { ms: 0 }, { timeoutMs: 5000 })).toEqual({ status: 'refused', reason: 'worker-failed' });
  });

  it('refuses at the time limit when the worker does not answer, and stops it', async () => {
    const { runner, check } = await slowCheck('never');
    const started = performance.now();
    expect(await runner.run(check, { ms: 0 }, { timeoutMs: 150 })).toEqual({ status: 'refused', reason: 'timeout' });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('stops the worker and refuses as cancelled when the request is cancelled, and starts none for a request already cancelled', async () => {
    const { runner, check } = await slowCheck('never');
    const controller = new AbortController();
    const running = runner.run(check, { ms: 0 }, { timeoutMs: 5000, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect(await running).toEqual({ status: 'refused', reason: 'cancelled' });
    expect(await runner.run(check, { ms: 0 }, { timeoutMs: 5000, signal: controller.signal })).toEqual({ status: 'refused', reason: 'cancelled' });
  });

  it('runs no more workers at once than the cap, makes a check wait for one, and counts the wait in its time limit', async () => {
    const stepped = steppedClock();
    const runner = createCheckRunner({ thresholdMs: 50, clock: stepped.clock, workerUrl: WORKER, maxWorkers: 1 });
    const check = checkOf('capped', 'slow', () => (stepped.advance(200), { echoed: 0 }));
    await runner.run(check, { ms: 0 }, { timeoutMs: 5000 });
    const started = performance.now();
    const both = await Promise.all([runner.run(check, { ms: 150 }, { timeoutMs: 5000 }), runner.run(check, { ms: 150 }, { timeoutMs: 5000 })]);
    expect(both.map((outcome) => outcome.status)).toEqual(['done', 'done']);
    expect(performance.now() - started).toBeGreaterThanOrEqual(290);
    const holder = runner.run(check, { ms: 400 }, { timeoutMs: 5000 });
    const waiter = await runner.run(check, { ms: 1 }, { timeoutMs: 100 });
    expect(waiter).toEqual({ status: 'refused', reason: 'timeout' });
    expect((await holder).status).toBe('done');
    const afterwards = await runner.run(check, { ms: 1 }, { timeoutMs: 5000 });
    expect(afterwards.status).toBe('done');
  });

  it('takes a check that is cancelled while it waits for a worker out of the line', async () => {
    const stepped = steppedClock();
    const runner = createCheckRunner({ thresholdMs: 50, clock: stepped.clock, workerUrl: WORKER, maxWorkers: 1 });
    const check = checkOf('capped-cancel', 'slow', () => (stepped.advance(200), { echoed: 0 }));
    await runner.run(check, { ms: 0 }, { timeoutMs: 5000 });
    const holder = runner.run(check, { ms: 200 }, { timeoutMs: 5000 });
    const controller = new AbortController();
    const waiter = runner.run(check, { ms: 1 }, { timeoutMs: 5000, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    expect(await waiter).toEqual({ status: 'refused', reason: 'cancelled' });
    expect((await holder).status).toBe('done');
    expect((await runner.run(check, { ms: 1 }, { timeoutMs: 5000 })).status).toBe('done');
  });
});
