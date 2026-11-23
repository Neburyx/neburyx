import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { createPanelRegistry } from '../workspace/panel-registry.js';
import { bindAssistantPanel } from './assistant-binder.js';
import { ASSISTANT_PANEL_ID, ASSISTANT_PANEL_WIDEST_SHARE, ASSISTANT_PANEL_WIDTH } from './panel-layout.js';

const registered = (panels: ReturnType<typeof createPanelRegistry>) => panels.view.getState().find(({ id }) => id === ASSISTANT_PANEL_ID);

describe('the Assistant panel registration', () => {
  it('registers a floating panel at the right that opens at 380 px and may be drawn at 60% of the window', () => {
    const state = createClientState();
    const panels = createPanelRegistry();
    const unbind = bindAssistantPanel(state, panels);
    act(() => state.presentation.setAssistantOpen(true));
    const panel = registered(panels);
    expect(panel?.initialWidth).toBe(ASSISTANT_PANEL_WIDTH);
    expect(panel?.widestShareOfWindow).toBe(ASSISTANT_PANEL_WIDEST_SHARE);
    expect(panel?.placement.kind === 'floating' ? panel.placement.side : undefined).toBe('right');
    unbind();
  });

  it('is taken out when closed and opens again at the width the person gave it', () => {
    const state = createClientState();
    const panels = createPanelRegistry();
    const unbind = bindAssistantPanel(state, panels);
    act(() => state.presentation.setAssistantOpen(true));
    act(() => state.presentation.setPanelSize(ASSISTANT_PANEL_ID, 700));
    act(() => state.presentation.setAssistantOpen(false));
    expect(registered(panels)).toBeUndefined();
    act(() => state.presentation.setAssistantOpen(true));
    expect(registered(panels)).toBeDefined();
    expect(state.presentation.view.getState().panelSizes.get(ASSISTANT_PANEL_ID)).toBe(700);
    unbind();
  });
});
