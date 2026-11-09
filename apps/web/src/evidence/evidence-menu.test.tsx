import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { edgeKey } from '../state/keys.js';
import { answerEdge, derivedDetailOf, detailOf, evidenceRig, inPanel, OWNS, panel, SHARED, SUMMED } from './evidence-kit.js';

afterEach(cleanup);

const openMenu = (rig: ReturnType<typeof evidenceRig>, edge = OWNS): void => void act(() => rig.state.presentation.setOpenMenu({ kind: 'relationship', key: edgeKey(edge.ref), x: 40, y: 40 }));
const menu = () => screen.getByRole('menu');
const names = (): string[] => within(menu()).getAllByRole('menuitem').map((item) => item.textContent ?? '');

describe('the relationship menu', () => {
  it('lists Why is this relationship here? with the Enter hint and View supporting records for a stored relationship', () => {
    const rig = evidenceRig();
    openMenu(rig);
    expect(names()).toEqual(['Why is this relationship here?↵', 'View supporting records']);
    rig.unbind();
  });

  it('lists both items for a derived relationship, opens the panel on it with Enter and reads it once', async () => {
    const rig = evidenceRig({}, [OWNS, SHARED, SUMMED]);
    openMenu(rig, SHARED);
    expect(names()).toEqual(['Why is this relationship here?↵', 'View supporting records']);
    await act(async () => undefined);
    await userEvent.keyboard('{Enter}');
    expect(panel()).not.toBeNull();
    expect(rig.edgeCalls).toHaveLength(1);
    await answerEdge(rig.edgeReads[0], derivedDetailOf());
    expect(inPanel().getByText('No confidence score')).toBeTruthy();
    rig.unbind();
  });

  it('lists neither for a relationship no evidence kind builds', () => {
    const rig = evidenceRig();
    openMenu(rig, SUMMED);
    expect(screen.queryByRole('menu')?.querySelectorAll('[role="menuitem"]').length ?? 0).toBe(0);
    rig.unbind();
  });

  it.each(['Why is this relationship here?', 'View supporting records'])('opens the evidence panel on the relationship, on Evidence, when %s is chosen', async (label) => {
    const rig = evidenceRig();
    openMenu(rig);
    await act(async () => within(menu()).getByRole('menuitem', { name: new RegExp(label.replace('?', '\\?')) }).click());
    expect(rig.edgeCalls.map((call) => call.id)).toEqual(['e1']);
    await answerEdge(rig.edgeReads[0], detailOf(OWNS));
    expect(inPanel().getByRole('tab', { name: 'Evidence' }).getAttribute('aria-selected')).toBe('true');
    expect(inPanel().getByText('R-e1')).toBeTruthy();
    rig.unbind();
  });

  it('opens the panel with Enter on the focused first row, reached by keyboard', async () => {
    const rig = evidenceRig();
    openMenu(rig);
    await act(async () => undefined);
    expect(document.activeElement).toBe(within(menu()).getByRole('menuitem', { name: /Why is this relationship here/ }));
    await userEvent.keyboard('{Enter}');
    expect(panel()).not.toBeNull();
    expect(rig.edgeCalls).toHaveLength(1);
    rig.unbind();
  });

  it('reaches both items by the arrow keys', async () => {
    const rig = evidenceRig();
    openMenu(rig);
    await act(async () => undefined);
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(within(menu()).getByRole('menuitem', { name: 'View supporting records' }));
    await userEvent.keyboard('{Enter}');
    expect(panel()).not.toBeNull();
    rig.unbind();
  });
});
