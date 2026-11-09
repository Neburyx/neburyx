import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { edgeKey } from '../state/keys.js';
import { count, entity, inspectorRig, keyOf, select } from './inspector-kit.js';
import { aggregateEdge, answerPreview, derivedEdge, openRelationships, openTab, panel, previewOf, rowNames, stored, unknownOrigin } from './relationship-kit.js';

const selected = (rig: Awaited<ReturnType<typeof openRelationships>>): string[] => [...rig.state.presentation.view.getState().selection];

describe('the Relationships tab: rows and selection', () => {
  it('is drawn between Overview and Properties', async () => {
    await openRelationships([]);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Overview', 'Relationships', 'Properties']);
  });

  it('lists one row for each drawn relationship of the entity, the other end only (the group heading names the type) with the type in its accessible name, and no other', async () => {
    await openRelationships([stored('r1', 'n1', 'n2'), stored('r2', 'n3', 'n1', 'USES'), stored('r3', 'n2', 'n3')]);
    expect(rowNames()).toEqual(['OWNS, Title n2 · Kind A, from this entity', 'USES, Title n3 · Kind A, to this entity']);
    const rows = [...document.querySelectorAll('.relationship-row')].map((row) => row.textContent);
    expect(rows).toEqual(['Title n2 · Kind A', 'Title n3 · Kind A']);
  });

  it('shows the title the node carries, masked when the session masks', async () => {
    const rig = inspectorRig({ nodes: [entity('n1'), entity('n2', [], { display: { title: 'J••• L•••', type: 'type-a' } })] });
    const { loadGraph } = await import('../workspace/context-menu-kit.js');
    loadGraph(rig.state, [entity('n1'), entity('n2', [], { display: { title: 'J••• L•••', type: 'type-a' } })], [stored('r1', 'n1', 'n2')]);
    select(rig.state, 'n1');
    await openTab();
    expect(rowNames()[0]).toContain('J••• L•••');
  });

  it('selects exactly that relationship when a row is activated, marks the row, and keeps the selection when it is activated again', async () => {
    const rig = await openRelationships([stored('r1', 'n1', 'n2'), stored('r2', 'n1', 'n3')]);
    const rows = screen.getAllByRole('button').filter((button) => button.classList.contains('relationship-row'));
    await userEvent.setup().click(rows[1] as HTMLElement);
    expect(selected(rig)).toEqual([edgeKey(stored('r2', 'n1', 'n3').ref)]);
    expect(screen.getAllByRole('button').filter((button) => button.getAttribute('aria-current') === 'true').map((button) => button.textContent)).toEqual(['Title n3 · Kind A']);
    await userEvent.setup().click(rows[1] as HTMLElement);
    expect(selected(rig)).toEqual([edgeKey(stored('r2', 'n1', 'n3').ref)]);
  });

  it('says no relationship is drawn when there is none', async () => {
    await openRelationships([]);
    expect(panel().getByText('No relationships of this entity are drawn.')).toBeTruthy();
    expect(rowNames()).toEqual([]);
  });

  it('draws no row for a relationship whose other end is hidden or not loaded', async () => {
    const rig = await openRelationships([stored('r1', 'n1', 'n2'), stored('r2', 'n1', 'n9')], ['n2', 'n3']);
    expect(rowNames()).toHaveLength(1);
    act(() => rig.state.hide([keyOf('n3')]));
    expect(rowNames()).toHaveLength(1);
    act(() => rig.state.hide([keyOf('n2')]));
    expect(rowNames()).toEqual([]);
  });

  it('drops a row whose relationship leaves the loaded graph, and no stale row selects anything', async () => {
    const rig = await openRelationships([stored('r1', 'n1', 'n2'), stored('r2', 'n1', 'n3')]);
    const { loadGraph } = await import('../workspace/context-menu-kit.js');
    act(() => loadGraph(rig.state, [entity('n1'), entity('n2'), entity('n3'), entity('n4')], [stored('r2', 'n1', 'n3')]));
    expect(rowNames()).toEqual(['OWNS, Title n3 · Kind A, from this entity']);
  });

  it('makes no request of its own: only the inspector\'s entity read and one degree preview', async () => {
    const rig = await openRelationships([stored('r1', 'n1', 'n2')]);
    await answerPreview(rig, previewOf());
    expect(rig.entityReads).toHaveLength(1);
    expect(rig.previews).toHaveLength(1);
    select(rig.state, 'n2');
    expect(rig.entityReads).toHaveLength(2);
    expect(rig.previews).toHaveLength(2);
  });
});

describe('the Relationships tab: derived, aggregate and unknown-origin rows', () => {
  it('puts a derived relationship in a Rule-derived group with "rule-derived" in place of the type, in no count', async () => {
    const rig = await openRelationships([stored('r1', 'n1', 'n2'), derivedEdge('n1', 'n3')]);
    await answerPreview(rig, previewOf({ byType: [{ relationshipType: 'OWNS', direction: 'out', count: count(1, 'exact'), neighborTypes: ['type-a'] }] }));
    expect(panel().getByRole('region', { name: 'Rule-derived' })).toBeTruthy();
    expect(rowNames()).toContain('SHARED, Title n3 · rule-derived, from this entity');
    expect(panel().getByRole('region', { name: 'OWNS' }).textContent).toContain('1 loaded of 1 · exact');
  });

  it('shows an aggregate with its member count and its quality, and counts it by its members', async () => {
    const rig = await openRelationships([aggregateEdge('n1', 'n2', count(12, 'lowerBound')), aggregateEdge('n1', 'n3', count(undefined, 'unknown')), aggregateEdge('n1', 'n4', count(5, 'estimated'))]);
    await answerPreview(rig, previewOf({ byType: [{ relationshipType: 'SENT', direction: 'out', count: count(40, 'exact'), neighborTypes: ['type-a'] }] }));
    const rows = [...document.querySelectorAll('.relationship-row')].map((row) => row.textContent);
    expect(rows).toEqual(['Title n2 · Kind A · ≥ 12 · lower bound', 'Title n3 · Kind A · no count', 'Title n4 · Kind A · ~ 5 (estimated)']);
    expect(panel().getByRole('region', { name: 'SENT' }).textContent).toContain('~ 18 loaded of 40 · exact');
  });

  it('drops the member count of an aggregate that is exactly one and exact, and shows it with its quality in every other case', async () => {
    await openRelationships([aggregateEdge('n1', 'n2', count(1, 'exact')), aggregateEdge('n1', 'n3', count(2, 'exact')), aggregateEdge('n1', 'n4', count(1, 'lowerBound'))]);
    const rows = [...document.querySelectorAll('.relationship-row')].map((row) => row.textContent);
    expect(rows).toEqual(['Title n2 · Kind A', 'Title n3 · Kind A · 2 · exact', 'Title n4 · Kind A · ≥ 1 · lower bound']);
  });

  it('keeps the type in the row of the groups whose heading does not name it', async () => {
    await openRelationships([derivedEdge('n1', 'n3'), unknownOrigin('r1', 'n1', 'n2')]);
    const rows = [...document.querySelectorAll('.relationship-row')].map((row) => row.textContent);
    expect(rows).toEqual(['SHAREDTitle n3 · rule-derived', 'LINKEDTitle n2 · Kind A']);
  });

  it('puts an unknown-origin relationship in an Origin not stated group with no count', async () => {
    await openRelationships([unknownOrigin('r1', 'n1', 'n2')]);
    const group = panel().getByRole('region', { name: 'Origin not stated' });
    expect(group.querySelector('.inspector-section-count')).toBeNull();
    expect(rowNames()).toEqual(['LINKED, Title n2 · Kind A, from this entity']);
  });

  it('draws neither group when there is no such relationship, and a derived edge whose end is not drawn has no row', async () => {
    await openRelationships([stored('r1', 'n1', 'n2'), derivedEdge('n1', 'n9')]);
    expect(panel().queryByRole('region', { name: 'Rule-derived' })).toBeNull();
    expect(panel().queryByRole('region', { name: 'Origin not stated' })).toBeNull();
  });

  it('selects a derived or unknown-origin row as any row', async () => {
    const rig = await openRelationships([derivedEdge('n1', 'n3'), unknownOrigin('r1', 'n1', 'n2')]);
    const user = userEvent.setup();
    for (const row of screen.getAllByRole('button').filter((button) => button.classList.contains('relationship-row'))) {
      await user.click(row);
      expect(selected(rig)).toHaveLength(1);
    }
  });
});
