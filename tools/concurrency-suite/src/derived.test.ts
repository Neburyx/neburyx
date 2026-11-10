import { afterEach, describe, expect, it } from 'vitest';
import { expectNothingLeft, finishAll, personNumber, startRig, type HttpAnswer, type Rig, type Route } from './rig.js';

let rig: Rig;
afterEach(async () => {
  await rig.close();
  expectNothingLeft(rig);
});

/** The two reads of the inspector that run a rule: the derived relationship's supports and the derived neighbors of an entity. */
const ROUTES: readonly { readonly name: string; readonly route: Route }[] = [
  { name: 'derived relationship read', route: 'derived-edge' },
  { name: 'derived neighbors read', route: 'derived-neighbors' },
];

describe.each(ROUTES)('the $name takes the same slots as the entity read', ({ route }) => {
  const read = (sourceId?: string) => rig.http(sourceId, route);

  it('lets exactly 2 of 10 simultaneous requests of one person reach the source and makes the other 8 wait', async () => {
    rig = await startRig();
    const sent = Array.from({ length: 10 }, () => read());
    await rig.until(() => rig.personHolds().held === 2 && rig.personHolds().waiting === 8, 'the person holds 2 slots with 8 waiting');
    expect(rig.data.started).toBe(2);
    await finishAll(rig, sent);
    expect((await Promise.all(sent)).map((answer) => answer.status)).toEqual(Array(10).fill(200));
    expect(rig.data.peak).toBe(2);
  });

  it('shares the 2 slots between the entity read and this read of one person', async () => {
    rig = await startRig();
    const sent = [rig.http(), read(), read(), rig.http()];
    await rig.until(() => rig.personHolds().held === 2 && rig.personHolds().waiting === 2, 'two reads run and two wait');
    expect(rig.data.started).toBe(2);
    await finishAll(rig, sent);
  });

  it('gives its slot back when the read ends by an answer, a timeout or an unreachable source', async () => {
    rig = await startRig({ budgets: { user_concurrency: 3 } });
    const sent = Array.from({ length: 3 }, () => read());
    await rig.until(() => rig.held.length === 3, 'three reads are held');
    const [answered, timedOut, failed] = rig.held.splice(0);
    answered?.answer();
    timedOut?.timeOut();
    failed?.fail();
    const answers = await Promise.all(sent);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 503, 504]);
    await rig.until(() => rig.personHolds().held === 0, 'the slots are given back');
  });
});

describe.each(ROUTES)('the $name counts against the request rate of 120 a minute', ({ route }) => {
  const refused = (answers: readonly HttpAnswer[]): number => answers.filter((answer) => answer.status === 429).length;

  it('refuses 80 of 200 simultaneous requests as RATE_LIMITED, with a wait', async () => {
    rig = await startRig();
    rig.mode = 'answer';
    const answers = await Promise.all(Array.from({ length: 200 }, () => rig.http(undefined, route)));
    expect(refused(answers)).toBe(80);
    for (const answer of answers.filter((each) => each.status === 429)) expect(answer.body.error).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(rig.data.started).toBe(120);
  });

  it('counts these reads and the entity reads of a person together', async () => {
    rig = await startRig();
    rig.mode = 'answer';
    const answers = await Promise.all(Array.from({ length: 140 }, (_, index) => (index % 2 === 0 ? rig.http(undefined, route) : rig.http())));
    expect(refused(answers)).toBe(20);
  });
});

describe.each(ROUTES)('repeated timeouts of the $name open the breaker for every read, and it closes again', ({ route }) => {
  const read = () => rig.http(undefined, route);

  it('refuses the next read after 5 concurrent timeouts as SOURCE_UNAVAILABLE with the reason and the wait, without asking the source', async () => {
    rig = await startRig();
    rig.mode = 'timeout';
    const answers = await Promise.all(Array.from({ length: 5 }, (_, index) => rig.http(undefined, route).then((answer) => ({ ...answer, person: personNumber(index + 1).id }))));
    expect(answers.map((answer) => answer.body.error?.code)).toEqual(Array(5).fill('QUERY_TIMEOUT'));
    const calls = rig.executor.calls.length;
    expect(await read()).toMatchObject({ status: 503, body: { error: { code: 'SOURCE_UNAVAILABLE', details: { reason: 'repeated-timeouts', retryAfterMs: 30_000 } } } });
    expect(rig.executor.calls.length).toBe(calls);
  });

  it('lets one trial read through after the cool-down and closes the breaker when it answers', async () => {
    rig = await startRig();
    rig.mode = 'timeout';
    await Promise.all(Array.from({ length: 5 }, () => read()));
    await rig.advance(30_000);
    rig.mode = 'answer';
    expect((await read()).status).toBe(200);
    expect((await read()).status).toBe(200);
  });
});
