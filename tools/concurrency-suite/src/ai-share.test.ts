import { afterEach, describe, expect, it } from 'vitest';
import { asAiReads } from '../../../services/api/src/seams/read-origin.js';
import { expectNothingLeft, finishAll, personNumber, SOURCE, startRig, type Rig } from './rig.js';

let rig: Rig;
afterEach(async () => {
  await rig.close();
  expectNothingLeft(rig);
});

const aiHeld = (): number | undefined => rig.slots.inspectAi().sources.get(SOURCE)?.aiHeld;

describe('the share of the read slots that AI reads may take, through the real gate', () => {
  it('lets 16 of 40 simultaneous AI reads of different people reach the source of 32 slots at a share of 0.5', async () => {
    rig = await startRig({ aiShare: 0.5 });
    const sent = Array.from({ length: 40 }, (_, index) => asAiReads(() => rig.asPerson(personNumber(index + 1))));
    await rig.until(() => rig.data.started === 16, 'sixteen AI reads reach the source');
    await rig.settle();
    expect(rig.data.started).toBe(16);
    expect(aiHeld()).toBe(16);
    await finishAll(rig, sent);
    expect(rig.data.peak).toBe(16);
  });

  it('serves a manual read of the same person at once while their AI read holds its share', async () => {
    rig = await startRig({ aiShare: 0.5 });
    const person = personNumber(1);
    const ai = asAiReads(() => rig.asPerson(person));
    const overShare = asAiReads(() => rig.asPerson(person));
    await rig.until(() => rig.data.started === 1, 'the first AI read reaches the source');
    const manual = rig.asPerson(person);
    await rig.until(() => rig.data.started === 2, 'the manual read reaches the source');
    expect(rig.personHolds(person)).toEqual({ held: 2, waiting: 1 });
    expect(rig.slots.inspectAi().users.get(JSON.stringify([SOURCE, person.id]))).toEqual({ aiHeld: 1, aiWaiting: 1 });
    await finishAll(rig, [ai, overShare, manual]);
  });
});
