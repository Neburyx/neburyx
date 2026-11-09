import { afterEach, describe, expect, it } from 'vitest';
import { expectNothingLeft, finishAll, startRig, type HttpAnswer, type Rig } from './rig.js';

let rig: Rig;
afterEach(async () => {
  await rig.close();
  expectNothingLeft(rig);
});

const link = (sourceId?: string) => rig.http(sourceId, 'link');

describe('the source link takes the slots of the entity read', () => {
  it('lets exactly 2 of 10 simultaneous requests of one person reach the source and makes the other 8 wait', async () => {
    rig = await startRig();
    const sent = Array.from({ length: 10 }, () => link());
    await rig.until(() => rig.personHolds().held === 2 && rig.personHolds().waiting === 8, 'the person holds 2 slots with 8 waiting');
    expect(rig.data.started).toBe(2);
    await finishAll(rig, sent);
    expect((await Promise.all(sent)).map((answer) => answer.status)).toEqual(Array(10).fill(302));
    expect(rig.data.peak).toBe(2);
  });

  it('shares the 2 slots between the entity read and the source link of one person', async () => {
    rig = await startRig();
    const sent = [rig.http(), link(), link(), rig.http()];
    await rig.until(() => rig.personHolds().held === 2 && rig.personHolds().waiting === 2, 'two reads run and two wait');
    expect(rig.data.started).toBe(2);
    await finishAll(rig, sent);
  });
});

describe('the source link counts against the request rate of 120 a minute', () => {
  const refused = (answers: readonly HttpAnswer[]): number => answers.filter((answer) => answer.status === 429).length;

  it('refuses 80 of 200 simultaneous requests as RATE_LIMITED, with a wait, and reads the source for the other 120', async () => {
    rig = await startRig();
    rig.mode = 'answer';
    const answers = await Promise.all(Array.from({ length: 200 }, () => link()));
    expect(refused(answers)).toBe(80);
    for (const answer of answers.filter((each) => each.status === 429)) expect(answer.body.error).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(rig.data.started).toBe(120);
  });
});

describe('repeated timeouts open the breaker for the source link too', () => {
  it('refuses the next link after 5 concurrent timeouts as SOURCE_UNAVAILABLE without asking the source', async () => {
    rig = await startRig();
    rig.mode = 'timeout';
    await Promise.all(Array.from({ length: 5 }, () => link()));
    const calls = rig.executor.calls.length;
    expect(await link()).toMatchObject({ status: 503, body: { error: { code: 'SOURCE_UNAVAILABLE' } } });
    expect(rig.executor.calls.length).toBe(calls);
  });
});
