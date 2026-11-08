import { afterEach, describe, expect, it } from 'vitest';
import { expectNothingLeft, finishAll, OTHER_SOURCE, personNumber, startRig, type Rig } from './rig.js';

let rig: Rig;
afterEach(async () => {
  await rig.close();
  expectNothingLeft(rig);
});

const outcomeOf = (promise: Promise<unknown>): Promise<{ code?: string; reason?: string; retryAfterMs?: number } | 'ok'> =>
  promise.then(
    () => 'ok' as const,
    (error: { code?: string; reason?: string; details?: { retryAfterMs?: number } }) => ({ ...(error.code === undefined ? {} : { code: error.code }), ...(error.reason === undefined ? {} : { reason: error.reason }), ...(error.details?.retryAfterMs === undefined ? {} : { retryAfterMs: error.details.retryAfterMs }) }),
  );

/** n reads of n different people at once, each timing out at the source. */
const timeOuts = async (count: number, first = 1): Promise<void> => {
  rig.mode = 'timeout';
  const outcomes = await Promise.all(Array.from({ length: count }, (_, index) => outcomeOf(rig.asPerson(personNumber(first + index)))));
  expect(outcomes).toEqual(Array(count).fill({ code: 'QUERY_TIMEOUT' }));
};

describe('repeated timeouts open the breaker', () => {
  it('refuses the next read after 5 concurrent timeouts as SOURCE_UNAVAILABLE with the reason and the wait, and the source is not asked', async () => {
    rig = await startRig();
    await timeOuts(5);
    const calls = rig.executor.calls.length;
    const answer = await rig.http();
    expect(answer).toMatchObject({ status: 503, body: { error: { code: 'SOURCE_UNAVAILABLE', retryable: true, details: { reason: 'repeated-timeouts', retryAfterMs: 30_000 } } }, retryAfter: '30' });
    expect(rig.executor.calls.length).toBe(calls);
    expect(rig.slots.inspect().sources.size).toBe(0);
    expect(rig.slots.inspect().users.size).toBe(0);
  });

  it('stays closed after 4 timeouts: the next read reaches the source', async () => {
    rig = await startRig();
    await timeOuts(4);
    rig.mode = 'answer';
    expect((await rig.http()).status).toBe(200);
  });

  it('counts the window as inclusive: the 5th timeout 60,000 ms after the 1st opens it, 60,001 ms after it does not', async () => {
    rig = await startRig();
    rig.mode = 'timeout';
    for (const gap of [15_000, 15_000, 15_000, 15_000]) {
      await outcomeOf(rig.asPerson(personNumber(1)));
      await rig.advance(gap);
    }
    await outcomeOf(rig.asPerson(personNumber(1)));
    expect(await outcomeOf(rig.asPerson(personNumber(1)))).toMatchObject({ code: 'SOURCE_UNAVAILABLE', reason: 'repeated-timeouts' });
    await rig.close();

    rig = await startRig();
    rig.mode = 'timeout';
    for (const gap of [15_000, 15_000, 15_000, 15_001]) {
      await outcomeOf(rig.asPerson(personNumber(1)));
      await rig.advance(gap);
    }
    expect(await outcomeOf(rig.asPerson(personNumber(1)))).toEqual({ code: 'QUERY_TIMEOUT' });
    expect(await outcomeOf(rig.asPerson(personNumber(1)))).toEqual({ code: 'QUERY_TIMEOUT' });
  });

  it('refuses 50 simultaneous reads while open, none waiting for a slot, and serves another source', async () => {
    rig = await startRig();
    await timeOuts(5);
    const calls = rig.executor.calls.length;
    const outcomes = await Promise.all(Array.from({ length: 50 }, (_, index) => outcomeOf(rig.asPerson(personNumber(100 + index)))));
    expect(outcomes.filter((each) => typeof each === 'object' && each.code === 'SOURCE_UNAVAILABLE' && each.reason === 'repeated-timeouts')).toHaveLength(50);
    expect(rig.executor.calls.length).toBe(calls);
    rig.mode = 'answer';
    expect(await outcomeOf(rig.asPerson(personNumber(1), OTHER_SOURCE))).toBe('ok');
  });

  it('lets reads that were running when it opened finish normally', async () => {
    rig = await startRig();
    const running = rig.http();
    await rig.until(() => rig.held.length === 1, 'a read is at the source');
    const keep = rig.held.shift();
    await timeOuts(5, 10);
    expect(await outcomeOf(rig.asPerson(personNumber(1)))).toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    keep?.answer();
    expect((await running).status).toBe(200);
  });

  it('is not moved by a cancelled read, a refusal for want of a slot, or a failure that is not a timeout', async () => {
    rig = await startRig({ budgets: { user_concurrency: 1 } });
    const person = personNumber(1);
    // failures that are not timeouts, 6 of them
    rig.mode = 'hold';
    for (let n = 0; n < 6; n += 1) {
      const failing = rig.asPerson(person);
      await rig.until(() => rig.held.length === 1, 'the read is held');
      rig.held.shift()?.fail();
      await outcomeOf(failing);
    }
    // cancelled reads, 6 of them
    for (let n = 0; n < 6; n += 1) {
      const controller = new AbortController();
      const cancelled = outcomeOf(rig.asPerson(person, undefined, controller.signal));
      await rig.until(() => rig.held.length === 1, 'the read is held');
      controller.abort();
      rig.held.shift()?.fail();
      await cancelled;
    }
    // reads refused as busy, 6 of them, behind a held read
    const holder = rig.asPerson(person);
    await rig.until(() => rig.held.length === 1, 'the holder is at the source');
    const busy = Array.from({ length: 6 }, () => outcomeOf(rig.asPerson(person)));
    await rig.until(() => rig.personHolds(person).waiting === 6, 'six wait');
    await rig.advance(2000);
    expect(await Promise.all(busy)).toEqual(Array(6).fill({ code: 'SOURCE_BUSY' }));
    rig.mode = 'answer';
    rig.held.shift()?.answer();
    await holder;
    expect(await outcomeOf(rig.asPerson(person))).toBe('ok');
  });
});

describe('the source coming back', () => {
  it('lets exactly one of 20 simultaneous reads through as the trial once the cool-down has passed, and refuses the rest with the time left', async () => {
    rig = await startRig();
    await timeOuts(5);
    await rig.advance(29_999);
    const early = await outcomeOf(rig.asPerson(personNumber(1)));
    expect(early).toMatchObject({ code: 'SOURCE_UNAVAILABLE', reason: 'repeated-timeouts', retryAfterMs: 1 });
    await rig.advance(1);
    rig.mode = 'hold';
    const reads = Array.from({ length: 20 }, (_, index) => outcomeOf(rig.asPerson(personNumber(200 + index))));
    await rig.until(() => rig.held.length === 1, 'one data read is the trial');
    expect(rig.data.started).toBe(6);
    rig.mode = 'answer';
    rig.held.shift()?.answer();
    const outcomes = await Promise.all(reads);
    expect(outcomes.filter((each) => each === 'ok')).toHaveLength(1);
    const refusals = outcomes.filter((each) => typeof each === 'object');
    expect(refusals).toHaveLength(19);
    // the trial's lease lives 15,000 ms and the clock has not moved since it was taken
    for (const each of refusals) expect(each).toMatchObject({ code: 'SOURCE_UNAVAILABLE', reason: 'repeated-timeouts', retryAfterMs: 15_000 });
  });

  it('closes on an answer and forgets the timeouts: it takes 5 new ones to open it again', async () => {
    rig = await startRig();
    await timeOuts(5);
    await rig.advance(30_000);
    rig.mode = 'answer';
    expect(await outcomeOf(rig.asPerson(personNumber(1)))).toBe('ok');
    expect(await outcomeOf(rig.asPerson(personNumber(1)))).toBe('ok');
    await timeOuts(4, 50);
    rig.mode = 'answer';
    expect(await outcomeOf(rig.asPerson(personNumber(1)))).toBe('ok');
  });

  it('opens again for a full cool-down when the trial times out', async () => {
    rig = await startRig();
    await timeOuts(5);
    await rig.advance(30_000);
    expect(await outcomeOf(rig.asPerson(personNumber(1)))).toEqual({ code: 'QUERY_TIMEOUT' });
    expect(await outcomeOf(rig.asPerson(personNumber(1)))).toMatchObject({ code: 'SOURCE_UNAVAILABLE', retryAfterMs: 30_000 });
    await rig.advance(29_999);
    expect(await outcomeOf(rig.asPerson(personNumber(1)))).toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    await rig.advance(1);
    rig.mode = 'answer';
    expect(await outcomeOf(rig.asPerson(personNumber(1)))).toBe('ok');
  });
});
