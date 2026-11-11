import { afterEach, describe, expect, it } from 'vitest';
import { AUTOSAVE_DELAY_MS, ref, startSuite, type Suite } from './rig.js';

let suite: Suite | undefined;
afterEach(async () => {
  await suite?.close();
  suite = undefined;
});

describe('the rig', () => {
  it('lets a request to the real API finish while the timers are faked, and sends an autosave only when the test advances them', async () => {
    suite = await startSuite();
    const tab = suite.tab();
    const opened = await tab.open(ref('hub', 'H-1'));
    expect(opened).toMatchObject({ kind: 'shown' });
    const id = tab.state.investigation.getState().id ?? '';
    await tab.load([ref('leaf', 'L-1')]);
    tab.state.presentation.setPositions(new Map([[tab.nodeKey('leaf', 'L-1'), { x: 10, y: 20 }]]));
    const writes = () => tab.requests.filter((request) => request === `PUT /v1/investigations/${id}/draft`);
    await suite.advance(AUTOSAVE_DELAY_MS - 1);
    expect(writes()).toHaveLength(0);
    await suite.advance(1);
    await suite.until(() => writes().length === 1, 'the autosave');
    await tab.written();
    expect(tab.sync.stateOf(id)?.version).toBe(2);
  });

  it('starts each suite from nothing', async () => {
    suite = await startSuite();
    expect(suite.store.investigations).toHaveLength(0);
    expect(suite.dataReads()).toEqual([]);
  });
});
