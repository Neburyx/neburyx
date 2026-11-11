import { afterEach, describe, expect, it } from 'vitest';
import { AUTOSAVE_DELAY_MS, ref, startSuite, type Suite } from './rig.js';

let suite: Suite | undefined;
afterEach(async () => {
  await suite?.close();
  suite = undefined;
});

describe('an investigation opened, moved and autosaved', () => {
  it('is stored with the positions the person gave and comes back with them in a fresh client', async () => {
    suite = await startSuite();
    const first = suite.tab();
    await first.open(ref('hub', 'H-1'));
    const id = first.state.investigation.getState().id ?? '';
    await first.load([ref('leaf', 'L-1'), ref('leaf', 'L-2')], [{ sourceId: 'demo', type: 'LINKED', from: 'hub', to: 'leaf', stableId: 'r-L1' }]);
    const moved = new Map([
      [first.nodeKey('leaf', 'L-1'), { x: 120, y: -40 }],
      [first.nodeKey('leaf', 'L-2'), { x: -75.5, y: 310 }],
    ]);
    first.state.presentation.setPositions(moved);
    await suite.advance(AUTOSAVE_DELAY_MS);
    await first.written();

    const stored = suite.draft();
    const placed = (stored?.layout.nodes ?? []).filter((node) => node.x !== undefined).map((node) => [node.id, node.x, node.y]);
    expect(placed.sort()).toEqual([['L-1', 120, -40], ['L-2', -75.5, 310]]);

    const second = suite.tab();
    expect(await second.openById(id)).toMatchObject({ kind: 'shown', id });
    expect(second.state.presentation.view.getState().positions).toEqual(first.state.presentation.view.getState().positions);
    expect(second.state.loadedGraph().nodes.map((node) => node.ref.stableId).sort()).toEqual(['H-1', 'L-1', 'L-2']);
    expect(second.state.loadedGraph().edges.map((edge) => ('stableId' in edge.ref ? edge.ref.stableId : ''))).toEqual(['r-L1']);
  });
});
