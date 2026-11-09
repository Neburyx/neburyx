import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { EdgeRef } from '@neburyx/contracts';
import { createEvidenceKindRegistry, kindOf } from './evidence-kinds.js';
import { storedEvidenceKind } from './stored-evidence.js';
import { answerEdge, detailOf, evidenceRig, failEdge, inPanel, keyOf, openOn, OWNS, panel, SENT, SUMMED, selectEdge } from './evidence-kit.js';
import { cleanup } from '@testing-library/react';

afterEach(cleanup);

describe('the evidence kinds', () => {
  const stored: EdgeRef = OWNS.ref;
  const kindWith = (id: string, order: number, matches: (ref: EdgeRef) => boolean) => ({ ...storedEvidenceKind, id, order, matches });

  it('registers, removes and matches kinds in order, and none matches a form no feature builds', () => {
    const kinds = createEvidenceKindRegistry();
    const removeStored = kinds.register(storedEvidenceKind);
    expect(kindOf(kinds.view.getState(), stored)?.id).toBe('stored');
    expect(kindOf(kinds.view.getState(), SUMMED.ref)).toBeUndefined();
    const removeOther = kinds.register(kindWith('other', 5, () => true));
    expect(kindOf(kinds.view.getState(), stored)?.id).toBe('other');
    removeOther();
    expect(kindOf(kinds.view.getState(), stored)?.id).toBe('stored');
    removeStored();
    expect(kindOf(kinds.view.getState(), stored)).toBeUndefined();
  });

  it('refuses a second kind with the same id', () => {
    const kinds = createEvidenceKindRegistry();
    kinds.register(storedEvidenceKind);
    expect(() => kinds.register(storedEvidenceKind)).toThrow();
  });
});

describe('the relationship evidence panel', () => {
  it('is not open until it is chosen, and selecting a relationship reads nothing', () => {
    const rig = evidenceRig();
    selectEdge(rig, OWNS);
    expect(panel()).toBeNull();
    expect(rig.edgeCalls).toEqual([]);
    rig.unbind();
  });

  it('docks on a choice, names the relationship, its ends and that it is read-only, with the three sub-tabs, and reads the edge once', async () => {
    const rig = evidenceRig();
    selectEdge(rig, OWNS);
    openOn(rig, OWNS);
    expect(rig.edgeCalls).toEqual([{ id: 'e1', mask: false, signal: expect.any(AbortSignal) }]);
    await answerEdge(rig.edgeReads[0], detailOf(OWNS));
    expect(inPanel().getByText('OWNS →')).toBeTruthy();
    expect(inPanel().getByRole('heading', { name: 'Relationship evidence' })).toBeTruthy();
    expect(inPanel().getByText('Title n1 → Title n2')).toBeTruthy();
    expect(inPanel().getByText('Selected relationship · source is read-only')).toBeTruthy();
    expect(inPanel().getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Evidence', 'Properties', 'Source']);
    expect(inPanel().getByRole('heading', { name: 'Why is this relationship here?' })).toBeTruthy();
    expect(inPanel().getByText('The source records this OWNS relationship from Title n1 to Title n2.')).toBeTruthy();
    expect(inPanel().getByText('R-e1')).toBeTruthy();
    expect(rig.edgeCalls).toHaveLength(1);
    rig.unbind();
  });

  it('shows an unreadable record as the product says it', async () => {
    const rig = evidenceRig();
    openOn(rig, OWNS);
    await answerEdge(rig.edgeReads[0], detailOf(OWNS, { evidence: { status: 'available', records: [{ property: 'docId', unreadable: true }] } }));
    expect(inPanel().getByText('docId: Value cannot be shown')).toBeTruthy();
    rig.unbind();
  });

  it('is offered for no relationship that no kind builds, and opens nothing for it', () => {
    const rig = evidenceRig();
    expect(rig.evidence.offers(SUMMED.ref)).toBe(false);
    let opened = true;
    act(() => void (opened = rig.evidence.open(SUMMED.ref)));
    expect(opened).toBe(false);
    expect(panel()).toBeNull();
    expect(rig.edgeCalls).toEqual([]);
    rig.unbind();
  });

  it('moves to the next selected stored relationship with one read, aborting the one in flight and dropping its late answer', async () => {
    const rig = evidenceRig();
    selectEdge(rig, OWNS);
    openOn(rig, OWNS);
    const first = rig.edgeCalls[0];
    selectEdge(rig, SENT);
    expect(first?.signal?.aborted).toBe(true);
    expect(rig.edgeCalls.map((call) => call.id)).toEqual(['e1', 'e2']);
    await answerEdge(rig.edgeReads[0], detailOf(OWNS));
    expect(inPanel().queryByText('R-e1')).toBeNull();
    await answerEdge(rig.edgeReads[1], detailOf(SENT));
    expect(inPanel().getByText('R-e2')).toBeTruthy();
    expect(inPanel().getByText('SENT →')).toBeTruthy();
    selectEdge(rig, SENT);
    expect(rig.edgeCalls).toHaveLength(2);
    rig.unbind();
  });

  it('keeps the same relationship and reads nothing more when the selection becomes none, an entity, several or an aggregate', async () => {
    const rig = evidenceRig();
    selectEdge(rig, OWNS);
    openOn(rig, OWNS);
    await answerEdge(rig.edgeReads[0], detailOf(OWNS));
    act(() => rig.state.presentation.select([]));
    expect(inPanel().getByText('Source is read-only')).toBeTruthy();
    expect(inPanel().getByText('R-e1')).toBeTruthy();
    act(() => rig.state.presentation.select([keyOf('n1'), keyOf('n2')]));
    expect(inPanel().getByText('R-e1')).toBeTruthy();
    act(() => rig.state.presentation.select([keyOf('n1')]));
    selectEdge(rig, SUMMED);
    expect(inPanel().getByText('R-e1')).toBeTruthy();
    expect(rig.edgeCalls).toHaveLength(1);
    rig.unbind();
  });

  it('closes with its button and Esc inside it, returns focus to what opened it, and does not clear the selection', async () => {
    const rig = evidenceRig();
    selectEdge(rig, OWNS);
    const opener = document.createElement('button');
    document.body.append(opener);
    act(() => void rig.evidence.open(OWNS.ref, opener));
    await answerEdge(rig.edgeReads[0], detailOf(OWNS));
    await act(async () => inPanel().getByRole('button', { name: 'Close relationship evidence' }).click());
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(opener);
    act(() => void rig.evidence.open(OWNS.ref, opener));
    const tab = inPanel().getByRole('tab', { name: 'Evidence' });
    tab.focus();
    act(() => void tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(rig.state.presentation.view.getState().selection.size).toBe(1);
    opener.remove();
    rig.unbind();
  });

  it('moves focus to its Evidence tab when chosen and not when it only follows the selection', async () => {
    const rig = evidenceRig();
    selectEdge(rig, OWNS);
    openOn(rig, OWNS);
    await act(async () => undefined);
    expect(document.activeElement).toBe(inPanel().getByRole('tab', { name: 'Evidence' }));
    (document.activeElement as HTMLElement).blur();
    selectEdge(rig, SENT);
    await act(async () => undefined);
    expect(document.activeElement).not.toBe(inPanel().getByRole('tab', { name: 'Evidence' }));
    rig.unbind();
  });

  it('closes when the masking changes, and reads again under the new setting when chosen', async () => {
    const rig = evidenceRig();
    openOn(rig, OWNS);
    await answerEdge(rig.edgeReads[0], detailOf(OWNS));
    act(() => rig.state.setMask(true));
    expect(panel()).toBeNull();
    openOn(rig, OWNS);
    expect(rig.edgeCalls.map((call) => call.mask)).toEqual([false, true]);
    rig.unbind();
  });

  it('shows a loading state with the screen as it was, then the evidence', async () => {
    const rig = evidenceRig();
    selectEdge(rig, OWNS);
    openOn(rig, OWNS);
    expect(inPanel().getByRole('status').textContent).toBe('Reading the evidence…');
    expect(rig.state.presentation.view.getState().selection.size).toBe(1);
    await failEdge(rig.edgeReads[0], 'SOURCE_BUSY', true);
    expect(screen.getByRole('alert')).toBeTruthy();
    rig.unbind();
  });
});
