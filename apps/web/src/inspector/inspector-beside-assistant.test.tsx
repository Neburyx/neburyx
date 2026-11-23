import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_PANEL_ID } from '../assistant/panel-layout.js';
import { PANEL_GAP } from '../workspace/panel-limits.js';
import { inspectorRig, select } from './inspector-kit.js';

const placementOf = (rig: ReturnType<typeof inspectorRig>) => rig.panels.view.getState().find(({ id }) => id === 'inspector')?.placement;

describe('the inspector beside the Assistant panel', () => {
  it('hangs beside the Assistant panel, whose drawn width the panel host measures, while the Assistant is open, and at the usual gap once it is closed', () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    expect(placementOf(rig)).toMatchObject({ kind: 'floating', side: 'right' });
    expect(placementOf(rig)).not.toHaveProperty('beside');
    act(() => rig.state.presentation.setAssistantOpen(true));
    expect(placementOf(rig)).toMatchObject({ beside: ASSISTANT_PANEL_ID });
    expect(placementOf(rig)).not.toHaveProperty('inset');
    act(() => rig.state.presentation.setAssistantOpen(false));
    expect(placementOf(rig)).not.toHaveProperty('beside');
  });

  it('opens already beside the Assistant panel when it was open first', () => {
    const rig = inspectorRig();
    act(() => rig.state.presentation.setAssistantOpen(true));
    select(rig.state, 'n1');
    expect(placementOf(rig)).toMatchObject({ beside: ASSISTANT_PANEL_ID });
  });

  it('is moved, not registered again, so the inspector keeps what it holds when the Assistant opens', () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    const before = rig.panels.view.getState().find(({ id }) => id === 'inspector')?.registration;
    act(() => rig.state.presentation.setAssistantOpen(true));
    expect(rig.panels.view.getState().find(({ id }) => id === 'inspector')?.registration).toBe(before);
  });

  it('keeps the inset of Ask, with no panel named, while Ask is open instead of the Assistant', () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    act(() => rig.state.presentation.setAskOpen(true));
    const placement = placementOf(rig);
    expect(placement).not.toHaveProperty('beside');
    expect(placement?.kind === 'floating' ? (placement.inset ?? PANEL_GAP) : undefined).toBeGreaterThan(PANEL_GAP);
  });
});
