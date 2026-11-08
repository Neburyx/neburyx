import { afterEach, describe, expect, it } from 'vitest';
import { expectNothingLeft, finishAll, OTHER_SOURCE, personNumber, SOURCE, startRig, type Rig } from './rig.js';

let rig: Rig;
afterEach(async () => {
  await rig.close();
  expectNothingLeft(rig);
});

const people = (count: number) => Array.from({ length: count }, (_, index) => personNumber(index + 1));

describe('the read slots of one person on a source', () => {
  it('lets exactly 2 of 10 simultaneous requests reach the source and makes the other 8 wait', async () => {
    rig = await startRig();
    const sent = Array.from({ length: 10 }, () => rig.http());
    await rig.until(() => rig.personHolds().held === 2 && rig.personHolds().waiting === 8, 'the person holds 2 slots with 8 waiting');
    expect(rig.data.started).toBe(2);
    expect(rig.held).toHaveLength(2);
    expect(rig.personHolds()).toEqual({ held: 2, waiting: 8 });
    await rig.settle();
    expect(rig.data.started).toBe(2);
    await finishAll(rig, sent);
    expect((await Promise.all(sent)).map((answer) => answer.status)).toEqual(Array(10).fill(200));
    expect(rig.data.peak).toBe(2);
  });

  it('starts exactly one waiting read when a held read ends, and the person still holds 2', async () => {
    rig = await startRig();
    const sent = Array.from({ length: 5 }, () => rig.http());
    await rig.until(() => rig.personHolds().waiting === 3, 'three reads wait');
    rig.held.shift()?.answer();
    await rig.until(() => rig.data.started === 3, 'the next read starts');
    await rig.settle();
    expect(rig.data.started).toBe(3);
    expect(rig.data.inFlight).toBe(2);
    expect(rig.personHolds()).toEqual({ held: 2, waiting: 2 });
    await finishAll(rig, sent);
    expect(rig.data.peak).toBe(2);
  });

  it('keeps a person who sends 5 at once to 2 without blocking the other 39 people, up to the source limit', async () => {
    rig = await startRig();
    const [greedy, ...others] = people(40);
    if (greedy === undefined) throw new Error('no person');
    const sent = [...Array.from({ length: 5 }, () => rig.asPerson(greedy)), ...others.map((person) => rig.asPerson(person))];
    await rig.until(() => rig.personHolds(greedy).waiting === 3, 'the greedy person waits with 3');
    await rig.until(() => rig.data.started === 32, 'the source is full');
    await rig.until(() => rig.slots.inspect().sources.get(SOURCE)?.waiting === 9, 'nine reads wait for the source');
    expect(rig.personHolds(greedy)).toEqual({ held: 2, waiting: 3 });
    expect(rig.data.started).toBe(32);
    expect(rig.held.filter((read) => read.traceId === `tr-${greedy.id}`)).toHaveLength(2);
    await finishAll(rig, sent);
  });

  it('gives both slots back when a read ends by an answer, a timeout or an unreachable source', async () => {
    rig = await startRig({ budgets: { user_concurrency: 3 } });
    const sent = Array.from({ length: 3 }, () => rig.http());
    await rig.until(() => rig.held.length === 3, 'three reads are held');
    const [answered, timedOut, failed] = rig.held.splice(0);
    answered?.answer();
    timedOut?.timeOut();
    failed?.fail();
    const answers = await Promise.all(sent);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 503, 504]);
    await rig.until(() => rig.slots.inspect().sources.size === 0 && rig.slots.inspect().users.size === 0, 'no slot is held');
  });
});

describe('the read slots of a source', () => {
  it('lets exactly 32 of 40 people reach the source, each holding a user slot, and makes the other 8 wait for the source', async () => {
    rig = await startRig();
    const sent = people(40).map((person) => rig.asPerson(person));
    await rig.until(() => rig.slots.inspect().sources.get(SOURCE)?.waiting === 8, 'eight reads wait for the source');
    await rig.until(() => rig.data.started === 32, '32 reads are at the source');
    expect(rig.slots.inspect().sources.get(SOURCE)).toEqual({ held: 32, waiting: 8 });
    expect(rig.data.started).toBe(32);
    for (const person of people(40)) expect(rig.personHolds(person).held).toBe(1);
    await rig.settle();
    expect(rig.data.started).toBe(32);
    await finishAll(rig, sent);
    expect(rig.data.peak).toBe(32);
  });

  it('serves a source while another is saturated', async () => {
    rig = await startRig({ budgets: { source_concurrency: 2 } });
    const [a, b, c] = people(3);
    if (a === undefined || b === undefined || c === undefined) throw new Error('no people');
    const sent = [rig.asPerson(a), rig.asPerson(b), rig.asPerson(c)];
    await rig.until(() => rig.slots.inspect().sources.get(SOURCE)?.waiting === 1, 'the third read waits for the saturated source');
    const other = rig.asPerson(c, OTHER_SOURCE);
    await rig.until(() => rig.startedAt(OTHER_SOURCE) === 1, 'the other source is served');
    expect(rig.startedAt(SOURCE)).toBe(2);
    await finishAll(rig, [...sent, other]);
  });

  it('never has more reads at the source than the limit while it waits for a slot to free', async () => {
    rig = await startRig({ budgets: { source_concurrency: 4, user_concurrency: 4 } });
    const sent = people(12).map((person) => rig.asPerson(person));
    await rig.until(() => rig.data.started === 4, 'four reads are at the source');
    for (let step = 0; step < 8; step += 1) {
      const before = rig.data.started;
      rig.held.shift()?.answer();
      await rig.until(() => rig.data.started === before + 1, 'one waiting read starts');
      expect(rig.data.inFlight).toBe(4);
    }
    await finishAll(rig, sent);
    expect(rig.data.peak).toBe(4);
  });
});
