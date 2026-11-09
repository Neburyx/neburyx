import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { count, entity, failEntity, keyOf, select } from './inspector-kit.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import { aggregateEdge, answerPreview, byType, openRelationships, panel, previewOf, rowNames, stored } from './relationship-kit.js';

const headingOf = (type: string): string => panel().getByRole('region', { name: type }).querySelector('.inspector-section-title')?.textContent ?? '';
const scope = (): string => [...document.querySelectorAll('.inspector-relationships > .inspector-scope')].map((line) => line.textContent ?? '').at(-1) ?? '';

describe('the Relationships tab: loaded counts per relationship type', () => {
  it('shows "n loaded of m" for each type, m summed over both directions, with the quality the preview gives', async () => {
    const rig = await openRelationships([stored('r1', 'n1', 'n2'), stored('r2', 'n3', 'n1')]);
    await answerPreview(rig, previewOf({ byType: [byType('OWNS', 'out', count(2, 'exact')), byType('OWNS', 'in', count(1, 'exact'))] }));
    expect(headingOf('OWNS')).toBe('OWNS2 loaded of 3 · exact');
  });

  it('weakens the total to estimated or a lower bound when any direction is, and prints no number when a direction has none', async () => {
    const rig = await openRelationships([stored('r1', 'n1', 'n2', 'KIND_A'), stored('r2', 'n1', 'n2', 'KIND_B'), stored('r3', 'n1', 'n2', 'KIND_C'), stored('r4', 'n1', 'n2', 'KIND_D')]);
    await answerPreview(
      rig,
      previewOf({
        byType: [
          byType('KIND_A', 'out', count(5, 'estimated')),
          byType('KIND_A', 'in', count(1, 'exact')),
          byType('KIND_B', 'out', count(5, 'lowerBound')),
          byType('KIND_B', 'in', count(1, 'exact')),
          byType('KIND_C', 'out', count(5, 'exact')),
          byType('KIND_C', 'in', count(undefined, 'unknown')),
          byType('KIND_D', 'out', count(undefined, 'unknown')),
        ],
      }),
    );
    expect(headingOf('KIND_A')).toBe('KIND_A1 loaded of ~ 6 (estimated)');
    expect(headingOf('KIND_B')).toBe('KIND_B1 loaded of ≥ 6 · lower bound');
    expect(headingOf('KIND_C')).toBe('KIND_C1 loaded');
    expect(headingOf('KIND_D')).toBe('KIND_D1 loaded');
  });

  it('draws a type the preview counts and nothing of it is loaded as "0 loaded of m" with no rows', async () => {
    const rig = await openRelationships([stored('r1', 'n1', 'n2')]);
    await answerPreview(rig, previewOf({ byType: [byType('OWNS', 'out', count(1, 'exact')), byType('USES', 'out', count(18, 'exact'))] }));
    expect(headingOf('USES')).toBe('USES0 loaded of 18 · exact');
    expect(panel().getByRole('region', { name: 'USES' }).querySelectorAll('.relationship-row')).toHaveLength(0);
  });

  it('says no relationship is drawn above the counts of types with nothing loaded, and draws no group for a type whose total is 0', async () => {
    const rig = await openRelationships([]);
    await answerPreview(rig, previewOf({ byType: [byType('OWNS', 'out', count(3, 'exact')), byType('EMPTY_TYPE', 'out', count(0, 'exact'))] }));
    expect(panel().getByText('No relationships of this entity are drawn.')).toBeTruthy();
    expect(headingOf('OWNS')).toBe('OWNS0 loaded of 3 · exact');
    expect(panel().queryByRole('region', { name: 'EMPTY_TYPE' })).toBeNull();
  });

  it('draws the rows and "n loaded" with no total while the preview is loading, and says it is counting', async () => {
    await openRelationships([stored('r1', 'n1', 'n2')]);
    expect(panel().getByText('Counting neighbors…')).toBeTruthy();
    expect(headingOf('OWNS')).toBe('OWNS1 loaded');
    expect(rowNames()).toHaveLength(1);
    expect(scope()).toBe('not loaded: no count');
  });

  it('keeps the rows when the preview fails, shows the failure with its retry, and reads again on retry', async () => {
    const rig = await openRelationships([stored('r1', 'n1', 'n2')]);
    await act(async () => rig.previews[0]?.answer({ ok: false, failure: { code: 'SOURCE_UNAVAILABLE', message: 'x', retryable: true, traceId: 'tr-9' } as never }));
    expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes('trace tr-9'))).toBe(true);
    expect(rowNames()).toHaveLength(1);
    expect(scope()).toBe('not loaded: no count');
    await userEvent.setup().click(panel().getByRole('button', { name: 'Retry' }));
    expect(rig.previews).toHaveLength(2);
    await failEntity(rig.entityReads[0], 'X');
  });

  it('ends with the scope line: what is loaded of the total and what is not', async () => {
    const rig = await openRelationships([stored('r1', 'n1', 'n2'), stored('r2', 'n1', 'n3')]);
    await answerPreview(rig, previewOf({ total: count(22, 'exact') }));
    expect(scope()).toBe('2 of 22 sourced neighbors on canvas · 20 not loaded');
  });

  it('keeps the quality of the loaded and the total in the scope line and prints no not-loaded number it cannot know', async () => {
    const rig = await openRelationships([aggregateEdge('n1', 'n2', count(4, 'lowerBound'))]);
    await answerPreview(rig, previewOf({ total: count(22, 'lowerBound') }));
    expect(scope()).toBe('≥ 4 of ≥ 22 sourced neighbors on canvas · not loaded: no count');
  });

  it('prints no not-loaded number when more is loaded than the total says', async () => {
    const rig = await openRelationships([stored('r1', 'n1', 'n2'), stored('r2', 'n1', 'n3')]);
    await answerPreview(rig, previewOf({ total: count(1, 'exact') }));
    expect(scope()).toBe('2 of 1 sourced neighbors on canvas · not loaded: no count');
  });

  it('says how many loaded relationships the view leaves out, counting a hidden end and an off type but not an end that is not loaded', async () => {
    const rig = await openRelationships([stored('r1', 'n1', 'n2'), stored('r2', 'n1', 'n3', 'USES'), stored('r3', 'n1', 'n9')]);
    await answerPreview(rig, previewOf());
    expect(screen.queryByText(/hidden or filtered out/)).toBeNull();
    act(() => rig.state.presentation.setMappedTypes({ entityTypes: ['type-a'], relationshipTypes: ['OWNS', 'USES'] }));
    act(() => rig.state.setRelationshipTypeOff('USES', true));
    expect(screen.getByText('1 loaded relationship is hidden or filtered out of the view')).toBeTruthy();
    act(() => rig.state.hide([keyOf('n2')]));
    expect(screen.getByText('2 loaded relationships are hidden or filtered out of the view')).toBeTruthy();
    expect(scope()).toBe('3 of 22 sourced neighbors on canvas · 19 not loaded');
  });

  it('follows an expansion with no new request', async () => {
    const rig = await openRelationships([stored('r1', 'n1', 'n2')]);
    await answerPreview(rig, previewOf());
    expect(scope()).toBe('1 of 22 sourced neighbors on canvas · 21 not loaded');
    act(() => loadGraph(rig.state, [entity('n1'), entity('n2'), entity('n3')], [stored('r1', 'n1', 'n2'), stored('r2', 'n1', 'n3')]));
    expect(rowNames()).toHaveLength(2);
    expect(scope()).toBe('2 of 22 sourced neighbors on canvas · 20 not loaded');
    expect(rig.previews).toHaveLength(1);
    expect(rig.entityReads).toHaveLength(1);
    select(rig.state, 'n1');
  });

  it('is the figure the Overview and the supernode panel give for the same entity', async () => {
    const { loadedOf, notLoadedOf, notLoadedText, loadedCountText } = await import('../workspace/node-counts.js');
    const rig = await openRelationships([stored('r1', 'n1', 'n2'), aggregateEdge('n1', 'n3', count(3, 'exact'))]);
    const preview = previewOf({ total: count(22, 'exact') });
    await answerPreview(rig, preview);
    const loaded = loadedOf(rig.state.loadedGraph(), { sourceId: 'a', entityType: 'type-a', stableId: 'n1' }).total;
    expect(scope()).toContain(`${loaded.value} of 22`);
    expect(`${loadedCountText(loaded)} · ${notLoadedText(notLoadedOf(preview.total, loaded))}`).toBe('4 loaded · 18 not loaded');
    expect(scope()).toContain('18 not loaded');
  });
});
