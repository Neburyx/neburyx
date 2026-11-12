import { act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { loadGraph } from '../workspace/context-menu-kit.js';
import { nodeOf, previewOf, relation } from '../workspace/supernode-kit.js';
import { count, entity, inInspector, inspectorRig, keyOf, select } from './inspector-kit.js';
import type { DegreePreview } from '@neburyx/contracts';

const answer = (rig: ReturnType<typeof inspectorRig>, value: DegreePreview, at = 0) => act(async () => rig.previews[at]?.answer({ ok: true, value }));
const section = () => inInspector().getByRole('region', { name: 'Sourced relationship ends' });

describe('the sourced relationship ends section', () => {
  it('says "Counting relationship ends…" until the preview answers', () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    expect(section().textContent).toContain('Counting relationship ends…');
  });

  it('puts the total with its quality in the title and one row per neighbor type with its count text', async () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    await answer(rig, previewOf());
    expect(section().querySelector('h3')?.textContent).toBe('Sourced relationship ends≥ 3,316 · lower bound');
    const rows = [...section().querySelectorAll('.inspector-row')].map((row) => row.textContent);
    expect(rows).toEqual(['kind-b15 · exact', 'type-c≥ 3,300 · lower bound', 'type-dno count']);
  });

  it('reads "n of total … on canvas · m not loaded" for an exact total, with the loaded relationships counted', async () => {
    const rig = inspectorRig();
    loadGraph(rig.state, [nodeOf('type-a', 'n1'), nodeOf('kind-b', 'b1')], [relation('r1', 'n1', 'b1')]);
    select(rig.state, 'n1');
    await answer(rig, previewOf({ total: count(22, 'exact') }));
    expect(section().querySelector('.inspector-scope')?.textContent).toBe('1 of 22 sourced relationship ends loaded · 21 not loaded');
  });

  it('reads "0 of …" when none are loaded, and keeps the quality of a lower-bound remainder', async () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    await answer(rig, previewOf());
    expect(section().querySelector('.inspector-scope')?.textContent).toBe('0 of ≥ 3,316 sourced relationship ends loaded · ≥ 3,316 not loaded (lower bound)');
  });

  it('keeps the quality of an estimated remainder', async () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    await answer(rig, previewOf({ total: count(500, 'estimated') }));
    expect(section().querySelector('.inspector-scope')?.textContent).toBe('0 of ~ 500 sourced relationship ends loaded · ~ 500 not loaded (estimated)');
  });

  it('invents no number when the total is unknown', async () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    await answer(rig, previewOf({ total: count(undefined, 'unknown') }));
    expect(section().querySelector('.inspector-scope')?.textContent).toBe('not loaded: no count');
    expect(section().querySelector('h3')?.textContent).toBe('Sourced relationship endsno count');
  });

  it('shows the failure line and Retry of a failed preview, keeps the rest, and asks again on Retry', async () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    await act(async () => rig.previews[0]?.answer({ ok: false, failure: { code: 'SOURCE_BUSY', message: 'x', retryable: true, traceId: 'tr-2' } as never }));
    expect(section().textContent).toContain('SOURCE_BUSY');
    expect(inInspector().getByRole('tab', { name: 'Properties' })).toBeTruthy();
    await userEvent.setup().click(inInspector().getByRole('button', { name: 'Retry' }));
    expect(rig.previews).toHaveLength(2);
  });

  it('makes no second request for a preview that was already answered', async () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    await answer(rig, previewOf());
    act(() => rig.state.presentation.select([]));
    select(rig.state, 'n1');
    expect(rig.previews).toHaveLength(1);
    expect(section().querySelectorAll('.inspector-row')).toHaveLength(3);
  });

  it('does not ask again when the preview is cancelled with the entity shown, and offers Retry', async () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    act(() => rig.previewStore.forNode({ sourceId: 'a', entityType: 'type-a', stableId: 'n1' }, false).cancel());
    expect(rig.previews).toHaveLength(1);
    expect(section().textContent).toContain('Relationship ends were not counted.');
    await userEvent.setup().click(inInspector().getByRole('button', { name: 'Retry' }));
    expect(rig.previews).toHaveLength(2);
    await answer(rig, previewOf(), 1);
    expect(section().querySelectorAll('.inspector-row')).toHaveLength(3);
  });

  it('asks once when a cancelled preview is shown again', () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    act(() => rig.previewStore.forNode({ sourceId: 'a', entityType: 'type-a', stableId: 'n1' }, false).cancel());
    act(() => rig.state.presentation.select([]));
    select(rig.state, 'n1');
    expect(rig.previews).toHaveLength(2);
  });

  it('is not drawn for a type with no neighbor types', async () => {
    const rig = inspectorRig({ nodes: [entity('n1')] });
    select(rig.state, 'n1');
    await answer(rig, previewOf({ byNeighborType: [], total: count(0, 'exact') }));
    expect(inInspector().queryByRole('region', { name: 'Sourced relationship ends' })).toBeNull();
  });

  it('draws nothing for the slot while it is empty and a row a later feature registers after the type rows', async () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    await answer(rig, previewOf());
    expect(section().querySelectorAll('.inspector-extra')).toHaveLength(0);
    act(() => void rig.inspector.neighborRows.register({ id: 'extra', order: 10, content: ({ entity: reference }) => <p className="inspector-extra">{`extra row for ${reference.stableId}`}</p> }));
    const rows = [...section().querySelectorAll('.inspector-row, .inspector-extra')].map((node) => node.className);
    expect(rows.at(-1)).toBe('inspector-extra');
    expect(section().textContent).toContain('extra row for n1');
    expect(keyOf('n1')).toBeTruthy();
  });
});
