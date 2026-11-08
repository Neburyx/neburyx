import { afterEach, describe, expect, it } from 'vitest';
import { expectNothingLeft, finishAll, startRig, type HttpAnswer, type Rig } from './rig.js';

let rig: Rig;
afterEach(async () => {
  await rig.close();
  expectNothingLeft(rig);
});

const refusedCount = (answers: readonly HttpAnswer[]): number => answers.filter((answer) => answer.status === 429).length;

describe('the request rate of 120 a minute', () => {
  it('refuses 80 of 200 simultaneous requests as RATE_LIMITED, retryable, with a wait of at least 1 ms', async () => {
    rig = await startRig();
    rig.mode = 'answer';
    const answers = await Promise.all(Array.from({ length: 200 }, () => rig.http()));
    expect(refusedCount(answers)).toBe(80);
    expect(answers.filter((answer) => answer.status === 200)).toHaveLength(120);
    for (const answer of answers.filter((each) => each.status === 429)) {
      expect(answer.body.error).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
      expect(answer.body.error?.details?.retryAfterMs).toBeGreaterThanOrEqual(1);
    }
    expect(rig.data.started).toBe(120);
  });

  it('admits the next request after the wait it named, and refuses it one millisecond earlier', async () => {
    rig = await startRig();
    rig.mode = 'answer';
    await Promise.all(Array.from({ length: 120 }, () => rig.http()));
    await rig.advance(30_000);
    const refused = await rig.http();
    expect(refused.status).toBe(429);
    const wait = refused.body.error?.details?.retryAfterMs ?? 0;
    expect(wait).toBe(30_000);
    await rig.advance(wait - 1);
    expect((await rig.http()).status).toBe(429);
    await rig.advance(1);
    expect((await rig.http()).status).toBe(200);
  });

  it('does not count a refused request: after the window slides only the admitted ones are counted', async () => {
    rig = await startRig();
    rig.mode = 'answer';
    await Promise.all(Array.from({ length: 120 }, () => rig.http()));
    await Promise.all(Array.from({ length: 50 }, () => rig.http()));
    expect([...rig.limiter.inspect().values()]).toEqual([120]);
    await rig.advance(60_000);
    expect([...rig.limiter.inspect().values()]).toEqual([]);
    expect((await rig.http()).status).toBe(200);
  });

  it('slides: 1 request per 500 ms for 3 minutes is never refused, and a burst at the end of one minute and one at the start of the next is refused until the first leaves the window', async () => {
    rig = await startRig();
    rig.mode = 'answer';
    let most = 0;
    for (let step = 0; step < 360; step += 1) {
      expect((await rig.http()).status).toBe(200);
      most = Math.max(most, ...rig.limiter.inspect().values());
      await rig.advance(500);
    }
    expect(most).toBe(120);
    rig = await replace(rig);
    await rig.advance(59_000);
    const first = await Promise.all(Array.from({ length: 120 }, () => rig.http()));
    expect(refusedCount(first)).toBe(0);
    await rig.advance(2000);
    const second = await Promise.all(Array.from({ length: 120 }, () => rig.http()));
    expect(refusedCount(second)).toBe(120);
    await rig.advance(59_000);
    expect(refusedCount(await Promise.all(Array.from({ length: 1 }, () => rig.http())))).toBe(0);
  });

  it('keeps sources apart, and honours a limit set on the source', async () => {
    rig = await startRig({ budgets: { requests_per_minute: 2 } });
    rig.mode = 'answer';
    expect([(await rig.http()).status, (await rig.http()).status, (await rig.http()).status]).toEqual([200, 200, 429]);
    expect((await rig.http('other')).status).toBe(200);
  });

  it('does not read the source for a refused request, and answers the routes that do not count at any rate', async () => {
    rig = await startRig({ budgets: { requests_per_minute: 1 } });
    rig.mode = 'answer';
    await rig.http();
    const before = rig.data.started;
    const refused = await Promise.all(Array.from({ length: 20 }, () => rig.http()));
    expect(refusedCount(refused)).toBe(20);
    expect(rig.data.started).toBe(before);
    expect(await rig.get('/v1/me')).toBe(200);
    expect(await rig.get('/healthz')).toBe(200);
    await finishAll(rig, []);
  });
});

async function replace(old: Rig): Promise<Rig> {
  await old.close();
  const fresh = await startRig();
  fresh.mode = 'answer';
  return fresh;
}
