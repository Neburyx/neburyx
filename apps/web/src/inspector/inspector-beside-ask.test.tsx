import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ASK_PANEL_ID, ASK_PANEL_WIDTH } from '../ask/ask-binder.js';
import { PANEL_GAP, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from '../workspace/panel-limits.js';
import { inspectorRig, select } from './inspector-kit.js';

const inspectorInset = (rig: ReturnType<typeof inspectorRig>): number | undefined => {
  const panel = rig.panels.view.getState().find(({ id }) => id === 'inspector');
  return panel?.placement.kind === 'floating' ? (panel.placement.inset ?? PANEL_GAP) : undefined;
};

describe('the inspector beside the Ask panel', () => {
  it('hangs at the usual gap while Ask is closed, and beside Ask, at the width of Ask between two gaps, while it is open', () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    expect(inspectorInset(rig)).toBe(PANEL_GAP);
    act(() => rig.state.presentation.setAskOpen(true));
    expect(inspectorInset(rig)).toBe(2 * PANEL_GAP + ASK_PANEL_WIDTH);
    act(() => rig.state.presentation.setAskOpen(false));
    expect(inspectorInset(rig)).toBe(PANEL_GAP);
  });

  it('opens already beside Ask when Ask was open first, and follows the width the person gave Ask', () => {
    const rig = inspectorRig();
    act(() => rig.state.presentation.setAskOpen(true));
    select(rig.state, 'n1');
    expect(inspectorInset(rig)).toBe(2 * PANEL_GAP + ASK_PANEL_WIDTH);
    act(() => rig.state.presentation.setPanelSize(ASK_PANEL_ID, 440));
    expect(inspectorInset(rig)).toBe(2 * PANEL_GAP + 440);
  });

  it('holds the width given to Ask to the limits it is drawn with, so a stored width below the least leaves room for the least and one above the most for the most', () => {
    const rig = inspectorRig();
    act(() => rig.state.presentation.setAskOpen(true));
    select(rig.state, 'n1');
    act(() => rig.state.presentation.setPanelSize(ASK_PANEL_ID, 200));
    expect(inspectorInset(rig)).toBe(2 * PANEL_GAP + PANEL_MIN_WIDTH);
    act(() => rig.state.presentation.setPanelSize(ASK_PANEL_ID, 900));
    expect(inspectorInset(rig)).toBe(2 * PANEL_GAP + PANEL_MAX_WIDTH);
  });

  it('is moved, not registered again: the registration of the inspector stays the same', () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    const before = rig.panels.view.getState().find(({ id }) => id === 'inspector')?.registration;
    act(() => rig.state.presentation.setAskOpen(true));
    expect(rig.panels.view.getState().find(({ id }) => id === 'inspector')?.registration).toBe(before);
  });
});
