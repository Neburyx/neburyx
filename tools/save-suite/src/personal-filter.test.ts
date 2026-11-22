import { afterEach, describe, expect, it } from 'vitest';
import { AUTOSAVE_DELAY_MS, mappingOf, ref, startSuite, type Suite } from './rig.js';

let suite: Suite | undefined;
afterEach(async () => {
  await suite?.close();
  suite = undefined;
});

const SECRET = 'SECRET-VALUE-9';
const IDENTITY = { on: 'entity', type: 'leaf', property: 'weight' } as const;
const PERSONAL = { entity: { hub: { filterable: [], kinds: {}, pii: [] }, leaf: { filterable: ['weight'], kinds: {}, pii: ['weight'] }, part: { filterable: [], kinds: {}, pii: [] } }, relationship: {} };

describe('a filter on a personal-data property', () => {
  it('is never in a draft write or a saved view, is not restored, and is cleared when masking turns on', async () => {
    suite = await startSuite({ mapping: mappingOf({ weight: 'personal' }) });
    const tab = suite.tab();
    await tab.open(ref('hub', 'H-1'));
    tab.mapProperties(['hub', 'leaf', 'part'], ['LINKED', 'HAS'], PERSONAL);
    await tab.load([ref('leaf', 'L-1')], []);
    tab.state.setPropertyCondition(IDENTITY, { ...IDENTITY, kind: 'text', op: 'in', values: [SECRET] });
    tab.state.presentation.setPositions(new Map([[tab.nodeKey('leaf', 'L-1'), { x: 5, y: 6 }]]));
    await suite.advance(AUTOSAVE_DELAY_MS);
    await tab.written();
    expect(tab.state.presentation.view.getState().typeFilter.properties).toHaveLength(1);
    expect(JSON.stringify(suite.store.drafts)).not.toContain(SECRET);
    expect(suite.draft()?.queryContext.filters.properties).toEqual([]);
    expect(JSON.stringify(tab.draftWrites())).not.toContain(SECRET);
    const id = tab.state.investigation.getState().id ?? '';
    tab.dispose();
    const reopened = suite.tab();
    await reopened.openById(id);
    reopened.mapProperties(['hub', 'leaf', 'part'], ['LINKED', 'HAS'], PERSONAL);
    expect(reopened.state.presentation.view.getState().typeFilter.properties).toHaveLength(0);
    reopened.state.setPropertyCondition(IDENTITY, { ...IDENTITY, kind: 'text', op: 'in', values: [SECRET] });
    reopened.state.setMask(true);
    expect(reopened.state.presentation.view.getState().typeFilter.properties).toHaveLength(0);
    expect(reopened.state.presentation.view.getState().personalFilterNote).toBe('Filter on weight cleared: masking is on.');
  });
});
