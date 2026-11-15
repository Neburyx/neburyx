import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SUMMARY_PANEL_ID, SUMMARY_PANEL_WIDTH } from '../summary/panel-layout.js';
import { PANEL_GAP } from '../workspace/panel-limits.js';
import { inspectorRig, select } from './inspector-kit.js';

const inspectorInset = (rig: ReturnType<typeof inspectorRig>): number | undefined => {
  const panel = rig.panels.view.getState().find(({ id }) => id === 'inspector');
  return panel?.placement.kind === 'floating' ? (panel.placement.inset ?? PANEL_GAP) : undefined;
};

describe('the inspector beside the summary panel', () => {
  it('hangs beside the summary panel while it is open, at the width given to it, and at the usual gap once it is closed', () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    expect(inspectorInset(rig)).toBe(PANEL_GAP);
    act(() => rig.state.presentation.setSummaryOpen(true));
    expect(inspectorInset(rig)).toBe(2 * PANEL_GAP + SUMMARY_PANEL_WIDTH);
    act(() => rig.state.presentation.setPanelSize(SUMMARY_PANEL_ID, 440));
    expect(inspectorInset(rig)).toBe(2 * PANEL_GAP + 440);
    act(() => rig.state.presentation.setSummaryOpen(false));
    expect(inspectorInset(rig)).toBe(PANEL_GAP);
  });
});
