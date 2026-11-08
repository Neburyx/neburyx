import { afterEach, describe, expect, it } from 'vitest';
import { HUB, startRig, type Rig } from './rig.js';

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

describe('the rig', () => {
  it('merges an expansion the scripted source answers, through the real API and client', async () => {
    rig = await startRig();
    const asked = rig.expand.expand(HUB, ['leaf']);
    (await rig.nextRead()).answerRows();
    expect(await asked).toBe('sent');
    expect(rig.state.loadedGraph().nodes.length).toBeGreaterThan(rig.loaded.nodes.length);
  });
});
