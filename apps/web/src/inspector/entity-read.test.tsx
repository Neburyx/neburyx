import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { answerEntity, entity, failEntity, inInspector, inspectorRig, keyOf, property, select } from './inspector-kit.js';

describe('the inspector reads the entity', () => {
  it('makes no read, and asks for no preview, for several selected entities or a relationship', () => {
    const rig = inspectorRig({ nodes: [entity('n1'), entity('n2')] });
    select(rig.state, 'n1', 'n2');
    expect(rig.entityCalls).toHaveLength(0);
    expect(rig.previews).toHaveLength(0);
  });

  it('makes one read when it opens and none when the same entity is selected again in the same state', async () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    expect(rig.entityCalls).toEqual([{ id: 'n1', mask: false, signal: expect.any(AbortSignal) }]);
    await answerEntity(rig.entityReads[0], entity('n1'));
    act(() => rig.state.presentation.select([]));
    select(rig.state, 'n1');
    expect(rig.entityCalls).toHaveLength(1);
  });

  it('asks with the masking flag only when the session is masked', () => {
    const state = createClientState();
    state.setMask(true);
    const rig = inspectorRig({ state });
    select(rig.state, 'n1');
    expect(rig.entityCalls[0]?.mask).toBe(true);
  });

  it('shows the loaded node while the read is on its way, then the answer, and leaves the loaded graph as it was', async () => {
    const rig = inspectorRig({ nodes: [entity('n1', [property('holder', 'Old')])] });
    select(rig.state, 'n1');
    const before = rig.state.loadedGraph();
    expect(inInspector().getByText('Reading details…')).toBeTruthy();
    expect(inInspector().getByText('Old')).toBeTruthy();
    await answerEntity(rig.entityReads[0], entity('n1', [property('holder', 'New')]));
    expect(inInspector().getByText('New')).toBeTruthy();
    expect(inInspector().queryByText('Reading details…')).toBeNull();
    expect(rig.state.loadedGraph()).toBe(before);
  });

  it('shows the duplicate-ID label with its sentence and the other labels the read returns', async () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    await answerEntity(rig.entityReads[0], entity('n1', [], { qualityFlags: ['duplicate-stable-id'] }));
    expect(inInspector().getByText('More than one entity has this ID')).toBeTruthy();
    expect(inInspector().getByText(/the one shown is the first the source returns/)).toBeTruthy();
  });

  it('says the item is no longer in the source for NOT_FOUND, with no Retry, and keeps the loaded node', async () => {
    const rig = inspectorRig({ nodes: [entity('n1', [property('holder', 'Kept')])] });
    select(rig.state, 'n1');
    await failEntity(rig.entityReads[0], 'NOT_FOUND', false);
    expect(inInspector().getByText('This item is no longer in the source.')).toBeTruthy();
    expect(inInspector().queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(inInspector().getByText('Kept')).toBeTruthy();
  });

  it.each(['SOURCE_BUSY', 'RATE_LIMITED', 'QUERY_TIMEOUT', 'SOURCE_UNAVAILABLE'])('offers Retry for %s and repeats the read', async (code) => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    await failEntity(rig.entityReads[0], code, true);
    expect(inInspector().getByText(/Some details could not be read\./)).toBeTruthy();
    await userEvent.setup().click(inInspector().getByRole('button', { name: 'Retry' }));
    expect(rig.entityCalls).toHaveLength(2);
    await answerEntity(rig.entityReads[1], entity('n1', [property('holder', 'Back')]));
    expect(inInspector().getByText('Back')).toBeTruthy();
    expect(inInspector().queryByText(/Some details could not be read\./)).toBeNull();
  });

  it('shows the message without Retry for a failure that cannot be retried', async () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    await failEntity(rig.entityReads[0], 'INTERNAL_ERROR', false);
    expect(inInspector().getByText(/Some details could not be read\./)).toBeTruthy();
    expect(inInspector().queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('leaves the canvas, the selection and the loaded graph as they were after a failure', async () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    const graph = rig.state.loadedGraph();
    await failEntity(rig.entityReads[0], 'QUERY_TIMEOUT', true);
    expect(rig.state.loadedGraph()).toBe(graph);
    expect([...rig.state.presentation.view.getState().selection]).toEqual([keyOf('n1')]);
  });

  it('stops the read of an entity that is no longer shown and never shows its answer for another entity', async () => {
    const rig = inspectorRig({ nodes: [entity('n1'), entity('n2')] });
    select(rig.state, 'n1');
    select(rig.state, 'n2');
    expect(rig.entityCalls[0]?.signal?.aborted).toBe(true);
    await answerEntity(rig.entityReads[0], entity('n1', [property('holder', 'ForN1')]));
    expect(inInspector().queryByText('ForN1')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Title n2' })).toBeTruthy();
  });
});
