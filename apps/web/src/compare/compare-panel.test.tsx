import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE_RECORD } from '../dev/fixture-loader.js';
import { aggregateEdge, derivedEdge, stored } from '../inspector/relationship-kit.js';
import { OWNS } from '../evidence/evidence-kit.js';
import { bar, chooseCompare, columns, compareRig, dock, entity, inDock, keyOf, kindsOf, profileWith, property, rows, select, selectEdges, TYPE } from './compare-kit.js';

afterEach(cleanup);

const nodesOf = (...pairs: ReadonlyArray<readonly [string, ...ReturnType<typeof property>[]]>) => pairs.map(([id, ...properties]) => entity(id, properties));
const holders = (...values: string[]) => nodesOf(...values.map((value, at) => [`n${at + 1}`, property('holder', value)] as const));

describe('Compare on the selection bar', () => {
  it('is on the bar from two selected items, opens the comparison without any read, and gives each entity a column', async () => {
    const rig = compareRig({ nodes: holders('Jordan', 'Sam', 'Alex') });
    select(rig.state, 'n1');
    expect(screen.queryByRole('toolbar', { name: 'Selection actions' })).toBeNull();
    select(rig.state, 'n1', 'n2');
    const before = rig.reads();
    await chooseCompare();
    expect(dock()).not.toBeNull();
    expect(columns()).toEqual(['Title n1', 'Title n2']);
    expect(rows()).toEqual([['holder', 'differs', 'Jordan', 'Sam']]);
    expect(rig.reads()).toBe(before);
    rig.unbind();
  });

  it('says that it needs entities or relationships, opens nothing and keeps its label, for a selection of both', async () => {
    const rig = compareRig({ edges: [OWNS] });
    act(() => rig.state.presentation.select([keyOf('n1'), keyOf('n2'), `["edge","a","stored","OWNS","type-a","type-a","e1"]`]));
    await chooseCompare();
    expect(dock()).toBeNull();
    expect(within(bar()).getByRole('button', { name: 'Compare' })).toBeTruthy();
    expect(within(bar()).getByText('Compare needs 2 to 5 entities or 2 to 5 relationships')).toBeTruthy();
    rig.unbind();
  });

  it('moves the focus to the panel on opening, and Esc closes it and gives the focus back to the button', async () => {
    const rig = compareRig();
    select(rig.state, 'n1', 'n2');
    const button = within(bar()).getByRole('button', { name: 'Compare' });
    button.focus();
    await chooseCompare();
    await waitFor(() => expect(document.activeElement).toBe(inDock().getByRole('heading', { name: 'Compare' })));
    await userEvent.setup().keyboard('{Escape}');
    expect(dock()).toBeNull();
    expect(document.activeElement).toBe(button);
    rig.unbind();
  });

  it('closes with its close button', async () => {
    const rig = compareRig();
    select(rig.state, 'n1', 'n2');
    await chooseCompare();
    await act(async () => inDock().getByRole('button', { name: 'Close comparison' }).click());
    expect(dock()).toBeNull();
    rig.unbind();
  });
});

describe('Compare in the menus', () => {
  const openMenu = (rig: ReturnType<typeof compareRig>, kind: 'node' | 'relationship', key: string): void => void act(() => rig.state.presentation.setOpenMenu({ kind, key, x: 20, y: 20 }));
  const items = (): string[] => screen.queryAllByRole('menuitem').map((item) => item.textContent ?? '');

  it('lists Compare in the menu of an entity when two or more entities are selected, and opens the comparison of the whole selection', async () => {
    const rig = compareRig({ nodes: holders('Jordan', 'Sam', 'Alex') });
    select(rig.state, 'n1', 'n2', 'n3');
    openMenu(rig, 'node', keyOf('n2'));
    expect(items()).toContain('Compare');
    await act(async () => within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Compare' }).click());
    expect(columns()).toEqual(['Title n1', 'Title n2', 'Title n3']);
    rig.unbind();
  });

  it('does not list it for one selected entity or for a mixed selection', () => {
    const rig = compareRig({ edges: [OWNS] });
    select(rig.state, 'n1');
    openMenu(rig, 'node', keyOf('n1'));
    expect(items()).not.toContain('Compare');
    act(() => rig.state.presentation.setOpenMenu(undefined));
    act(() => rig.state.presentation.select([keyOf('n1'), keyOf('n2'), `["edge","a","stored","OWNS","type-a","type-a","e1"]`]));
    openMenu(rig, 'node', keyOf('n1'));
    expect(items()).not.toContain('Compare');
    rig.unbind();
  });

  it('lists Compare in the menu of a relationship for two or more relationships, and not for one', async () => {
    const second = stored('e2', 'n1', 'n3', 'OWNS');
    const rig = compareRig({ edges: [OWNS, second] });
    selectEdges(rig, OWNS);
    openMenu(rig, 'relationship', `["edge","a","stored","OWNS","type-a","type-a","e1"]`);
    expect(items()).not.toContain('Compare');
    act(() => rig.state.presentation.setOpenMenu(undefined));
    selectEdges(rig, OWNS, second);
    openMenu(rig, 'relationship', `["edge","a","stored","OWNS","type-a","type-a","e1"]`);
    expect(items()).toContain('Compare');
    rig.unbind();
  });
});

describe('the dock', () => {
  it('holds the comparison or the relationship evidence, one at a time, and each replaces the other', async () => {
    const rig = compareRig({ evidence: true, edges: [OWNS] });
    act(() => void rig.evidence?.open(OWNS.ref));
    expect(screen.getByRole('complementary', { name: 'Relationship evidence' })).toBeTruthy();
    select(rig.state, 'n1', 'n2');
    await chooseCompare();
    expect(screen.queryByRole('complementary', { name: 'Relationship evidence' })).toBeNull();
    expect(dock()).not.toBeNull();
    act(() => void rig.evidence?.open(OWNS.ref));
    expect(dock()).toBeNull();
    expect(screen.getByRole('complementary', { name: 'Relationship evidence' })).toBeTruthy();
    rig.unbind();
  });
});

describe('the rows', () => {
  it('mark the rows whose values differ and not the others, and hide the rows that are the same on the switch', async () => {
    const nodes = nodesOf(['n1', property('currency', 'USD'), property('status', 'active')], ['n2', property('currency', 'USD'), property('status', 'frozen')], ['n3', property('currency', 'USD'), property('status', 'active')]);
    const rig = compareRig({ nodes, profile: profileWith(['currency', 'status']) });
    select(rig.state, 'n1', 'n2', 'n3');
    await chooseCompare();
    expect(rows().map(([label, status]) => [label, status])).toEqual([['currency', 'same'], ['status', 'differs']]);
    expect(inDock().getAllByText('Differs')).toHaveLength(1);
    await userEvent.setup().click(inDock().getByRole('switch', { name: 'Differences only' }));
    expect(rows().map(([label]) => label)).toEqual(['status']);
    expect(inDock().getByText('Showing 1 of 2 rows')).toBeTruthy();
    await userEvent.setup().click(inDock().getByRole('switch', { name: 'Differences only' }));
    expect(rows()).toHaveLength(2);
    rig.unbind();
  });

  it('also hide the rows where only one element has a value, count every hidden row in the line, and show all of them again when the switch is off', async () => {
    const base = profileWith(['holder', 'opened']);
    const profile = { ...base, entityTypes: [...base.entityTypes, { ...(base.entityTypes[0] ?? (() => { throw new Error('no type'); })()), type: 'type-b', properties: ['holder', 'band'] }] };
    const nodes = [entity('n1', [property('holder', 'Jordan'), property('opened', 'x')]), { ...entity('n2', [property('holder', 'Sam'), property('band', 'retail')]), ref: { sourceId: 'a', entityType: 'type-b', stableId: 'n2' } }];
    const rig = compareRig({ nodes, profile });
    act(() => rig.state.presentation.select([keyOf('n1'), `["node","a","type-b","n2"]`]));
    await chooseCompare();
    expect(rows().map(([label]) => label)).toEqual(['holder', 'opened', 'band']);
    await userEvent.setup().click(inDock().getByRole('switch', { name: 'Differences only' }));
    expect(rows().map(([label]) => label)).toEqual(['holder']);
    expect(inDock().getByText('Showing 1 of 3 rows')).toBeTruthy();
    await userEvent.setup().click(inDock().getByRole('switch', { name: 'Differences only' }));
    expect(rows()).toHaveLength(3);
    rig.unbind();
  });

  it('keep a row with a masked cell on the switch even when no other element has a value', async () => {
    const base = profileWith(['holder']);
    const profile = { ...base, entityTypes: [...base.entityTypes, { ...(base.entityTypes[0] ?? (() => { throw new Error('no type'); })()), type: 'type-b', properties: ['band'] }] };
    const nodes = [entity('n1', [property('holder', 'J••• L•••', 'name', true)]), { ...entity('n2', [property('band', 'retail')]), ref: { sourceId: 'a', entityType: 'type-b', stableId: 'n2' } }];
    const rig = compareRig({ nodes, profile });
    act(() => rig.state.presentation.select([keyOf('n1'), `["node","a","type-b","n2"]`]));
    await chooseCompare();
    await userEvent.setup().click(inDock().getByRole('switch', { name: 'Differences only' }));
    expect(rows().map(([label, status]) => [label, status])).toEqual([['holder', 'cannot']]);
    expect(inDock().getByText('Showing 1 of 2 rows')).toBeTruthy();
    rig.unbind();
  });

  it('say that nothing differs when every row is the same and the switch is on', async () => {
    const rig = compareRig({ nodes: holders('Jordan', 'Jordan'), profile: profileWith(['holder']) });
    select(rig.state, 'n1', 'n2');
    await chooseCompare();
    await userEvent.setup().click(inDock().getByRole('switch', { name: 'Differences only' }));
    expect(inDock().getByText('No differences among the compared elements')).toBeTruthy();
    rig.unbind();
  });

  it('start with the switch off each time the comparison opens', async () => {
    const rig = compareRig({ nodes: holders('Jordan', 'Sam'), profile: profileWith(['holder']) });
    select(rig.state, 'n1', 'n2');
    await chooseCompare();
    await userEvent.setup().click(inDock().getByRole('switch', { name: 'Differences only' }));
    await chooseCompare();
    expect((inDock().getByRole('switch', { name: 'Differences only' }) as HTMLInputElement).checked).toBe(false);
    rig.unbind();
  });
});

describe('the column titles', () => {
  it('leave out the reference under a title that holds it, keep the type, and still name the full reference to a screen reader', async () => {
    const rig = compareRig({ nodes: [entity('n1', [property('holder', 'A')]), entity('n2', [property('holder', 'B')], { display: { title: 'Jordan', type: 'type-a' } })] });
    select(rig.state, 'n1', 'n2');
    await chooseCompare();
    const [first, second] = inDock().getAllByRole('columnheader').slice(1);
    expect(first?.querySelector('.compare-column-reference')).toBeNull();
    expect(first?.querySelector('.compare-column-caption')?.textContent).toBe('Kind A');
    expect(inDock().getByRole('columnheader', { name: 'Title n1, Kind A, n1' })).toBeTruthy();
    expect(second?.querySelector('.compare-column-reference')?.textContent).toBe('n2');
    rig.unbind();
  });

  it('keep the reference when it is only part of a longer word in the title', async () => {
    const rig = compareRig({ nodes: [entity('n1', [property('holder', 'A')], { display: { title: 'Title n10', type: 'type-a' } }), entity('n2', [property('holder', 'B')])] });
    select(rig.state, 'n1', 'n2');
    await chooseCompare();
    expect(inDock().getAllByRole('columnheader')[1]?.querySelector('.compare-column-reference')?.textContent).toBe('n1');
    rig.unbind();
  });
});

describe('a masked value', () => {
  it('is drawn as its mask with a masked label, never makes a row the same, and stays under the switch', async () => {
    const nodes = nodesOf(['n1', property('holder', 'J••• L•••', 'name', true), property('status', 'a')], ['n2', property('holder', 'J••• L•••', 'name', true), property('status', 'a')]);
    const rig = compareRig({ nodes, profile: profileWith(['holder', 'status']) });
    select(rig.state, 'n1', 'n2');
    await chooseCompare();
    expect(rows()).toEqual([['holder', 'cannot', 'J••• L•••', 'J••• L•••'], ['status', 'same', 'a', 'a']]);
    expect(inDock().getAllByText('masked')).toHaveLength(2);
    expect(inDock().getByText('includes masked values')).toBeTruthy();
    await userEvent.setup().click(inDock().getByRole('switch', { name: 'Differences only' }));
    expect(rows().map(([label]) => label)).toEqual(['holder']);
    rig.unbind();
  });
});

describe('entities of different types and with missing properties', () => {
  it('reads "not mapped" where the type maps no such property, differently from an unavailable value', async () => {
    const base = profileWith(['holder', 'opened']);
    const profile = { ...base, entityTypes: [...base.entityTypes, { ...(base.entityTypes[0] ?? (() => { throw new Error('no type'); })()), type: 'type-b', properties: ['holder', 'band'] }] };
    const nodes = [entity('n1', [property('holder', 'Jordan')]), { ...entity('n2', [property('holder', 'Sam'), property('band', 'retail')]), ref: { sourceId: 'a', entityType: 'type-b', stableId: 'n2' } }];
    const rig = compareRig({ nodes, profile });
    act(() => rig.state.presentation.select([keyOf('n1'), `["node","a","type-b","n2"]`]));
    await chooseCompare();
    expect(rows().map(([label, status]) => [label, status])).toEqual([['holder', 'differs'], ['opened', 'cannot'], ['band', 'cannot']]);
    expect(kindsOf('opened')).toEqual(['unavailable', 'not-mapped']);
    expect(kindsOf('band')).toEqual(['not-mapped', 'value']);
    expect(rig.reads()).toBe(0);
    rig.unbind();
  });

  it('says that no property is mapped in common when none is', async () => {
    const base = profileWith(['holder']);
    const profile = { ...base, entityTypes: [...base.entityTypes, { ...(base.entityTypes[0] ?? (() => { throw new Error('no type'); })()), type: 'type-b', properties: ['band'] }] };
    const nodes = [entity('n1', [property('holder', 'Jordan')]), { ...entity('n2', [property('band', 'retail')]), ref: { sourceId: 'a', entityType: 'type-b', stableId: 'n2' } }];
    const rig = compareRig({ nodes, profile });
    act(() => rig.state.presentation.select([keyOf('n1'), `["node","a","type-b","n2"]`]));
    await chooseCompare();
    expect(inDock().getByText('These elements have no mapped property in common')).toBeTruthy();
    rig.unbind();
  });

  it('draws an element of a type the profile does not hold from the properties it carries', async () => {
    const rig = compareRig({ nodes: holders('Jordan', 'Sam'), profile: { ...profileWith(['holder']), entityTypes: [] } });
    select(rig.state, 'n1', 'n2');
    await chooseCompare();
    expect(rows()).toEqual([['holder', 'differs', 'Jordan', 'Sam']]);
    rig.unbind();
  });
});

describe('relationships', () => {
  const second = stored('e2', 'n1', 'n3', 'OWNS');

  it('compares two stored relationships by the mapped properties of their type and by Observed, with the ends and origin in the header, and makes no request', async () => {
    const one = { ...OWNS, properties: [property('lane', 'web')], observedAt: '2026-11-09T10:00:00Z' };
    const two = { ...second, properties: [property('lane', 'phone')] };
    const rig = compareRig({ edges: [one, two], profile: profileWith(['holder'], { OWNS: ['lane'] }) });
    selectEdges(rig, one, two);
    await chooseCompare();
    expect(columns()).toEqual(['OWNS', 'OWNS']);
    expect(inDock().getAllByRole('columnheader')[1]?.textContent).toContain('Title n1 → Title n2 · stored');
    expect(rows()).toEqual([['lane', 'differs', 'web', 'phone'], ['Observed', 'cannot', '9 Nov 2026, 10:00:00 UTC', 'not stated']]);
    expect(rig.reads()).toBe(0);
    rig.unbind();
  });

  it('compares two aggregate relationships by their member count with its quality, and leaves their property cells out of the comparison', async () => {
    const one = aggregateEdge('n1', 'n2', { value: 42, quality: 'exact', scope: 'x' });
    const two = aggregateEdge('n1', 'n3', { value: 7, quality: 'lowerBound', scope: 'x' });
    const rig = compareRig({ edges: [one, two], profile: profileWith(['holder'], { SENT: ['lane'] }) });
    selectEdges(rig, one, two);
    await chooseCompare();
    expect(rows()).toEqual([['lane', 'cannot', 'varies by member', 'varies by member'], ['Observed', 'cannot', 'not stated', 'not stated'], ['Members', 'differs', '42 · exact', '≥ 7 · lower bound']]);
    rig.unbind();
  });

  it('shows an aggregate\'s first and last observed as one range, equal only to the same range', async () => {
    const one = { ...aggregateEdge('n1', 'n2', { value: 2, quality: 'exact', scope: 'x' }), observedFirst: '2026-11-01T10:00:00Z', observedLast: '2026-11-09T10:00:00Z' };
    const two = { ...aggregateEdge('n1', 'n3', { value: 2, quality: 'exact', scope: 'x' }), observedFirst: '2026-11-01T10:00:00Z', observedLast: '2026-11-09T10:00:00Z' };
    const rig = compareRig({ edges: [one, two] });
    selectEdges(rig, one, two);
    await chooseCompare();
    expect(rows().find(([label]) => label === 'Observed')).toEqual(['Observed', 'same', '1 Nov 2026, 10:00:00 UTC to 9 Nov 2026, 10:00:00 UTC', '1 Nov 2026, 10:00:00 UTC to 9 Nov 2026, 10:00:00 UTC']);
    rig.unbind();
  });

  it('compares a stored relationship\'s single time and an aggregate\'s range of times as different things, never against each other', async () => {
    const one = { ...OWNS, observedAt: '2026-11-09T10:00:00Z' };
    const two = { ...aggregateEdge('n1', 'n3', { value: 2, quality: 'exact', scope: 'x' }), observedFirst: '2026-11-01T10:00:00Z', observedLast: '2026-11-09T10:00:00Z' };
    const rig = compareRig({ edges: [one, two] });
    selectEdges(rig, one, two);
    await chooseCompare();
    expect(rows().find(([label]) => label === 'Observed')).toEqual(['Observed', 'cannot', '9 Nov 2026, 10:00:00 UTC', '1 Nov 2026, 10:00:00 UTC to 9 Nov 2026, 10:00:00 UTC']);
    rig.unbind();
  });

  it('takes the properties of the row of the mapping that has the relationship\'s type and both end types, and leaves the stable ID and the observed time out of the property rows', async () => {
    const profile = profileWith(['holder'], [
      { type: 'OWNS', from: TYPE, to: 'type-b', properties: ['route'] },
      { type: 'OWNS', from: TYPE, to: TYPE, properties: ['recId', 'seenAt', 'lane'], observedAt: 'seenAt', stableIdProperty: 'recId' },
    ]);
    const one = { ...OWNS, properties: [property('recId', 'E1'), property('seenAt', '2026-11-09T10:00:00Z', 'dateTime'), property('lane', 'web')], observedAt: '2026-11-09T10:00:00Z' };
    const two = { ...stored('e2', 'n1', 'n3', 'OWNS'), properties: [property('recId', 'E2'), property('seenAt', '2026-11-08T10:00:00Z', 'dateTime'), property('lane', 'web')], observedAt: '2026-11-08T10:00:00Z' };
    const rig = compareRig({ edges: [one, two], profile });
    selectEdges(rig, one, two);
    await chooseCompare();
    expect(rows().map(([label, status]) => [label, status])).toEqual([['lane', 'same'], ['Observed', 'differs']]);
    rig.unbind();
  });

  it('compares two derived relationships by their Rule, says rule-derived in the header, and reads not mapped for every property', async () => {
    const one = derivedEdge('n1', 'n2');
    const two = { ...derivedEdge('n1', 'n3'), derivation: { ruleId: 'rule-2', ruleVersion: 3, supportingEdgeRefs: [] } };
    const rig = compareRig({ edges: [one, two, OWNS], profile: profileWith(['holder'], { OWNS: ['lane'] }) });
    selectEdges(rig, one, two);
    await chooseCompare();
    expect(inDock().getAllByRole('columnheader')[1]?.textContent).toContain('rule-derived · rule-1 v1');
    expect(rows().find(([label]) => label === 'Rule')).toEqual(['Rule', 'differs', 'rule-1 v1', 'rule-2 v3']);
    expect(rows().find(([label]) => label === 'Observed')?.[1]).toBe('cannot');
    rig.unbind();
  });
});

describe('the limit and the set', () => {
  const eight = (): ReturnType<typeof holders> => holders('A', 'B', 'C', 'D', 'E', 'F', 'G');

  it('reads Compare for five, "Compare 5 of 7" for seven, compares the first five in selection order and names the other two', async () => {
    const rig = compareRig({ nodes: eight() });
    select(rig.state, 'n1', 'n2', 'n3', 'n4', 'n5');
    expect(within(bar()).getByRole('button', { name: 'Compare' })).toBeTruthy();
    select(rig.state, 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7');
    expect(within(bar()).getByRole('button', { name: 'Compare 5 of 7' })).toBeTruthy();
    await chooseCompare();
    expect(columns()).toEqual(['Title n1', 'Title n2', 'Title n3', 'Title n4', 'Title n5']);
    expect(inDock().getByText('Comparing 5 of the 7 selected when opened')).toBeTruthy();
    const left = within(inDock().getByRole('region', { name: 'Not compared' }));
    expect(left.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Title n6 · Kind A', 'Title n7 · Kind A']);
    rig.unbind();
  });

  it('says "Comparing 5" for exactly five', async () => {
    const rig = compareRig({ nodes: eight() });
    select(rig.state, 'n1', 'n2', 'n3', 'n4', 'n5');
    await chooseCompare();
    expect(inDock().getByText('Comparing 5')).toBeTruthy();
    expect(inDock().queryByRole('region', { name: 'Not compared' })).toBeNull();
    rig.unbind();
  });

  it('keeps the table as it is when other elements are selected, makes no request, and builds a new one when Compare is chosen again', async () => {
    const rig = compareRig({ nodes: holders('A', 'B', 'C') });
    select(rig.state, 'n1', 'n2');
    await chooseCompare();
    select(rig.state, 'n2', 'n3');
    expect(columns()).toEqual(['Title n1', 'Title n2']);
    expect(rig.reads()).toBe(0);
    await chooseCompare();
    expect(columns()).toEqual(['Title n2', 'Title n3']);
    rig.unbind();
  });

  it('takes the column of an element hidden from the view out and says so, and says that fewer than two remain when the last one goes', async () => {
    const rig = compareRig({ nodes: holders('A', 'B', 'C') });
    select(rig.state, 'n1', 'n2', 'n3');
    await chooseCompare();
    act(() => rig.state.hide([keyOf('n3')]));
    expect(columns()).toEqual(['Title n1', 'Title n2']);
    expect(inDock().getByText('Title n3 was removed from the view and is no longer compared')).toBeTruthy();
    act(() => rig.state.hide([keyOf('n2')]));
    expect(inDock().getByText('Fewer than two compared elements remain in the view.')).toBeTruthy();
    expect(inDock().queryByRole('table')).toBeNull();
    act(() => rig.state.presentation.showAllHidden());
    expect(inDock().queryByRole('table')).toBeNull();
    rig.unbind();
  });

  it('closes on a change of the masking setting, and the focus goes back to the control that opened it', async () => {
    const rig = compareRig();
    select(rig.state, 'n1', 'n2');
    const button = within(bar()).getByRole('button', { name: 'Compare' });
    button.focus();
    await chooseCompare();
    act(() => rig.state.setMask(true));
    expect(dock()).toBeNull();
    expect(document.activeElement, 'the focus goes back to the control that opened it').toBe(button);
    rig.unbind();
  });
});

describe('a change of investigation', () => {
  it('closes the comparison', async () => {
    const rig = compareRig();
    select(rig.state, 'n1', 'n2');
    await chooseCompare();
    act(() => void rig.state.show({ id: 'other', sourceId: 'a', record: FIXTURE_RECORD, resultKeys: [], nodeRefs: [], edgeRefs: [] }, []));
    expect(dock()).toBeNull();
    expect(document.activeElement?.classList.contains('graph-canvas'), 'the opener is gone, so the focus goes to the canvas').toBe(true);
    rig.unbind();
  });
});

describe('copying', () => {
  const written: string[] = [];
  const setup = (refuse = false) => {
    written.length = 0;
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (text: string) => (refuse ? Promise.reject(new Error('denied')) : void written.push(text)));
    return userEvent.setup();
  };

  it('copies a column and the table as they are drawn, masks and unavailable values included', async () => {
    const session = setup();
    const nodes = nodesOf(['n1', property('holder', 'J•••', 'name', true), property('status', 'a')], ['n2', property('holder', 'K•••', 'name', true)]);
    const rig = compareRig({ nodes, profile: profileWith(['holder', 'status']) });
    select(rig.state, 'n1', 'n2');
    await chooseCompare();
    await session.click(inDock().getByRole('button', { name: 'Copy column Title n2' }));
    expect(written.at(-1)).toBe('Title n2 (Kind A)\nholder: K•••\nstatus: unavailable');
    await session.click(inDock().getByRole('button', { name: 'Copy table' }));
    expect(written.at(-1)).toBe('Property\tTitle n1\tTitle n2\nholder\tJ•••\tK•••\nstatus\ta\tunavailable');
    rig.unbind();
  });

  it('says Differences only on the first line of what it copies when the switch is on, and copies only the rows shown', async () => {
    const session = setup();
    const nodes = nodesOf(['n1', property('holder', 'A'), property('status', 'x')], ['n2', property('holder', 'B'), property('status', 'x')]);
    const rig = compareRig({ nodes, profile: profileWith(['holder', 'status']) });
    select(rig.state, 'n1', 'n2');
    await chooseCompare();
    await session.click(inDock().getByRole('switch', { name: 'Differences only' }));
    await session.click(inDock().getByRole('button', { name: 'Copy table' }));
    expect(written.at(-1)).toBe('Differences only\nProperty\tTitle n1\tTitle n2\nholder\tA\tB');
    rig.unbind();
  });

  it('says Could not copy as an alert when the clipboard refuses, and changes nothing else', async () => {
    const session = setup(true);
    const rig = compareRig();
    select(rig.state, 'n1', 'n2');
    await chooseCompare();
    await session.click(inDock().getByRole('button', { name: 'Copy table' }));
    await waitFor(() => expect(inDock().getAllByRole('alert').map((region) => region.textContent)).toContain('Could not copy'));
    expect(columns()).toEqual(['Title n1', 'Title n2']);
    rig.unbind();
  });
});

describe('the keyboard', () => {
  it('puts Close first after the title, then the switch, Copy table, the sideways scroll region and each Copy column', async () => {
    const rig = compareRig();
    select(rig.state, 'n1', 'n2');
    await chooseCompare();
    const session = userEvent.setup();
    inDock().getByRole('heading', { name: 'Compare' }).focus();
    const order: string[] = [];
    for (let step = 0; step < 6; step += 1) {
      await session.tab();
      const active = document.activeElement;
      order.push(active?.getAttribute('aria-label') ?? active?.getAttribute('role') ?? active?.tagName ?? '');
    }
    expect(order.slice(0, 6)).toEqual(['Close comparison', 'switch', 'Copy table', 'Comparison table', 'Copy column Title n1', 'Copy column Title n2']);
    rig.unbind();
  });
});
