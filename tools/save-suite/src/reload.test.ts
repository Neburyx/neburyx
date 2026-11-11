import { afterEach, describe, expect, it } from 'vitest';
import { AUTOSAVE_DELAY_MS, ref, startSuite, type Suite, type Tab } from './rig.js';

let suite: Suite | undefined;
afterEach(async () => {
  await suite?.close();
  suite = undefined;
});

const writes = (tab: Tab) => tab.draftWrites();
const at = (tab: Tab, stableId: string) => tab.nodeKey('leaf', stableId);

/** An investigation with two leaves loaded, one change stored by autosave. */
async function started(running: Suite): Promise<{ readonly tab: Tab; readonly id: string }> {
  const tab = running.tab();
  await tab.open(ref('hub', 'H-1'));
  const id = tab.state.investigation.getState().id ?? '';
  await tab.load([ref('leaf', 'L-1'), ref('leaf', 'L-2')]);
  tab.state.presentation.setPositions(new Map([[at(tab, 'L-1'), { x: 10, y: 10 }]]));
  await running.advance(AUTOSAVE_DELAY_MS);
  await tab.written();
  return { tab, id };
}

describe('the page closed in the middle of an investigation', () => {
  it('writes the change made less than the autosave delay ago when the page is hidden, and a fresh client shows it', async () => {
    suite = await startSuite();
    const { tab, id } = await started(suite);
    const stored = writes(tab).length;
    tab.state.presentation.setPositions(new Map([[at(tab, 'L-2'), { x: 77, y: -3 }]]));
    expect(writes(tab)).toHaveLength(stored);
    suite.page.fire('pagehide');
    await suite.until(() => writes(tab).length === stored + 1, 'the keepalive write');
    expect(tab.keepalives).toEqual([writes(tab).at(-1)]);
    await tab.written();
    const fresh = suite.tab();
    await fresh.openById(id);
    expect(fresh.state.presentation.view.getState().positions.get(at(fresh, 'L-2'))).toEqual({ x: 77, y: -3 });
  });

  it('shows the last stored draft, never a partial one, when nothing was written after the last change', async () => {
    suite = await startSuite();
    const { tab, id } = await started(suite);
    tab.state.presentation.setPositions(new Map([[at(tab, 'L-2'), { x: 500, y: 500 }]]));
    tab.dispose();
    const fresh = suite.tab();
    await fresh.openById(id);
    const positions = fresh.state.presentation.view.getState().positions;
    expect(positions.get(at(fresh, 'L-1'))).toEqual({ x: 10, y: 10 });
    expect(positions.has(at(fresh, 'L-2'))).toBe(false);
    expect(fresh.state.loadedGraph().nodes.map((node) => node.ref.stableId).sort()).toEqual(['H-1', 'L-1', 'L-2']);
  });
});

describe('a draft some of whose items the source no longer holds', () => {
  it('shows the readable items, says some are missing, and never shortens the stored draft', async () => {
    suite = await startSuite();
    const { id } = await started(suite);
    suite.world.remove('leaf', 'L-2');
    const fresh = suite.tab();
    expect(await fresh.openById(id)).toMatchObject({ kind: 'shown', someMissing: true });
    expect(fresh.state.loadedGraph().nodes.map((node) => node.ref.stableId).sort()).toEqual(['H-1', 'L-1']);
    fresh.sync.flush();
    fresh.state.presentation.setPositions(new Map([[at(fresh, 'L-1'), { x: 11, y: 11 }]]));
    await suite.advance(AUTOSAVE_DELAY_MS);
    await fresh.written();
    expect(suite.draft()?.layout.nodes.map((node) => node.id).sort()).toEqual(['H-1', 'L-1', 'L-2']);
  });
});

describe('the first viewport of an investigation whose draft held none', () => {
  it('is the drawing\'s own: neither the open nor that first fit writes, and the next viewport does', async () => {
    suite = await startSuite();
    const tab = suite.tab();
    await tab.open(ref('hub', 'H-1'));
    await suite.advance(AUTOSAVE_DELAY_MS);
    expect(writes(tab)).toEqual([]);
    tab.state.presentation.setViewport({ zoom: 1, x: 0, y: 0 });
    await suite.advance(AUTOSAVE_DELAY_MS);
    expect(writes(tab)).toEqual([]);
    tab.state.presentation.setViewport({ zoom: 2, x: 5, y: 5 });
    await suite.advance(AUTOSAVE_DELAY_MS);
    await tab.written();
    expect(writes(tab)).toHaveLength(1);
  });
});
