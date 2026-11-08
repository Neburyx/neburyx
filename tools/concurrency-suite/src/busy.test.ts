import { afterEach, describe, expect, it } from 'vitest';
import type { Coordinator, ReadAdmission } from '../../../services/api/src/seams/seams.js';
import { expectNothingLeft, finishAll, personNumber, startRig, type Rig } from './rig.js';

let rig: Rig;
afterEach(async () => {
  await rig.close();
  expectNothingLeft(rig);
});

const settledAs = (promise: Promise<unknown>): Promise<'pending' | 'resolved' | 'rejected'> => Promise.race([promise.then(() => 'resolved' as const, () => 'rejected' as const), new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending')))]);

describe('a read that finds no slot within the wait', () => {
  it('stays queued until 2,000 ms and then answers SOURCE_BUSY as retryable, never reaching the source', async () => {
    rig = await startRig();
    const sent = [rig.http(), rig.http()];
    await rig.until(() => rig.personHolds().held === 2, 'the person holds both slots');
    const third = rig.http();
    await rig.until(() => rig.personHolds().waiting === 1, 'the third request waits');
    await rig.advance(1999);
    expect(rig.personHolds().waiting).toBe(1);
    expect(await settledAs(third)).toBe('pending');
    await rig.advance(1);
    const answer = await third;
    expect(answer).toMatchObject({ status: 503, body: { error: { code: 'SOURCE_BUSY', retryable: true } } });
    expect(rig.data.started).toBe(2);
    await finishAll(rig, sent);
  });

  it('counts as busy exactly the requests that found no slot, and none of them reached the source', async () => {
    rig = await startRig({ budgets: { user_concurrency: 1 } });
    const holder = rig.http();
    await rig.until(() => rig.personHolds().held === 1, 'the slot is held');
    const refused = Array.from({ length: 6 }, () => rig.http());
    await rig.until(() => rig.personHolds().waiting === 6, 'six wait');
    await rig.advance(2000);
    const answers = await Promise.all(refused);
    expect(answers.map((answer) => answer.body.error?.code)).toEqual(Array(6).fill('SOURCE_BUSY'));
    expect(rig.data.started).toBe(1);
    await finishAll(rig, [holder]);
    expect(rig.slots.inspect().users.size).toBe(0);
  });
});

describe('the order of the waiting reads', () => {
  it('starts them in the order they came, one slot at a time', async () => {
    rig = await startRig({ budgets: { user_concurrency: 1 } });
    const order: number[] = [];
    const person = personNumber(1);
    const first = rig.asPerson(person);
    await rig.until(() => rig.data.started === 1, 'the first read is at the source');
    const waiting = [1, 2, 3].map((n) => {
      const read = rig.asPerson(person).then(() => order.push(n));
      return read;
    });
    await rig.until(() => rig.personHolds(person).waiting === 3, 'three wait');
    const traces: string[] = [];
    for (let step = 0; step < 3; step += 1) {
      rig.held.shift()?.answer();
      await rig.until(() => rig.held.length === 1, 'the next read in line starts');
      traces.push(String(rig.data.started));
    }
    rig.held.shift()?.answer();
    await Promise.all([first, ...waiting]);
    expect(order).toEqual([1, 2, 3]);
    expect(traces).toEqual(['2', '3', '4']);
  });
});

describe('a read refused as busy', () => {
  it('gives back the user slot it took on the way, so a later request is admitted when a held read ends', async () => {
    rig = await startRig({ budgets: { source_concurrency: 1, user_concurrency: 2 } });
    const [a, b] = [personNumber(1), personNumber(2)];
    const holder = rig.asPerson(a);
    const refused = rig.asPerson(b).then(() => undefined, (error: unknown) => error);
    await rig.until(() => rig.personHolds(b).held === 1 && rig.slots.inspect().sources.get('demo')?.waiting === 1, 'the second person took a user slot and waits for the source');
    await rig.advance(2000);
    expect(await refused).toMatchObject({ code: 'SOURCE_BUSY' });
    expect(rig.personHolds(b)).toEqual({ held: 0, waiting: 0 });
    const later = rig.asPerson(b);
    rig.held.shift()?.answer();
    await rig.until(() => rig.held.length === 1, 'the later request is admitted');
    rig.held.shift()?.answer();
    await Promise.all([holder, later]);
  });
});

describe('a lease whose read never releases it', () => {
  /** A crash: the gate always releases, so the coordinator is wrapped to drop the release of the first lease. */
  const crashing = (inner: Coordinator): Coordinator => {
    let crashed = false;
    return {
      acquireRead: async (request): Promise<ReadAdmission> => {
        const admission = await inner.acquireRead(request);
        if (admission.status !== 'granted' || crashed || request.role !== 'data') return admission;
        crashed = true;
        return { status: 'granted', lease: { release: () => Promise.resolve() } };
      },
    };
  };

  it('frees both slots by itself at its time to live (the deadline plus the source timeout), not a millisecond before', async () => {
    rig = await startRig({ budgets: { user_concurrency: 2 }, wrap: crashing });
    const crashed = rig.http();
    await rig.until(() => rig.held.length === 1, 'the read that will crash is at the source');
    await rig.advance(1000);
    const second = rig.http();
    await rig.until(() => rig.held.length === 2, 'a second read holds the person\'s other slot, with a lease that outlives the first by 1,000 ms');
    // time to live: the 10,000 ms left to the request deadline plus the 5,000 ms source timeout, counted from the start of the lease
    await rig.advance(12_500);
    expect(rig.personHolds().held).toBe(2);
    const proving = rig.http();
    await rig.until(() => rig.personHolds().waiting === 1, 'the proving read waits');
    await rig.advance(1499);
    expect(rig.personHolds()).toEqual({ held: 2, waiting: 1 });
    expect(rig.data.started).toBe(2);
    await rig.advance(1);
    await rig.until(() => rig.data.started === 3, 'the proving read starts at the expiry');
    expect(rig.personHolds()).toEqual({ held: 2, waiting: 0 });
    await finishAll(rig, [crashed, second, proving]);
  });

  it('answers SOURCE_BUSY to a read sent more than the wait before the expiry', async () => {
    rig = await startRig({ budgets: { user_concurrency: 1 } });
    const crashed = rig.http();
    await rig.until(() => rig.held.length === 1, 'the read is at the source');
    const early = rig.http();
    await rig.until(() => rig.personHolds().waiting === 1, 'the early read waits');
    await rig.advance(2000);
    expect(await early).toMatchObject({ status: 503, body: { error: { code: 'SOURCE_BUSY' } } });
    await finishAll(rig, [crashed]);
  });

  it('frees no slot twice when the read ends and releases after the expiry', async () => {
    rig = await startRig({ budgets: { user_concurrency: 1 } });
    const late = rig.http();
    await rig.until(() => rig.held.length === 1, 'the read is at the source');
    const lateRead = rig.held.shift();
    await rig.advance(15_000);
    expect(rig.personHolds().held).toBe(0);
    const next = rig.http();
    await rig.until(() => rig.held.length === 1, 'the next read holds the slot');
    lateRead?.answer();
    await late;
    await rig.settle();
    expect(rig.personHolds()).toEqual({ held: 1, waiting: 0 });
    await finishAll(rig, [next]);
  });
});
