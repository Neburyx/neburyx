import { describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { bindLegend, LEGEND_PANEL_ID } from './legend-binder.js';
import { createPanelRegistry, createPanelRegistryFor } from './panel-registry.js';

function bound() {
  const state = createClientState();
  const panels = createPanelRegistry();
  const unbind = bindLegend(state, panels);
  return { state, panels, unbind };
}

describe('the legend\'s panel', () => {
  it('is not registered while the legend is closed', () => {
    const { panels } = bound();
    expect(panels.view.getState()).toEqual([]);
  });

  it('is registered when the legend opens, as a floating panel on the right, 64 px from the top, 320 px wide, and taken out when it closes', () => {
    const { state, panels } = bound();
    state.presentation.setLegendOpen(true);
    const [panel] = panels.view.getState();
    expect(panels.view.getState()).toHaveLength(1);
    expect(panel).toMatchObject({ id: LEGEND_PANEL_ID, title: 'Legend', placement: { kind: 'floating', side: 'right', top: 64 }, initialWidth: 320 });
    state.presentation.setLegendOpen(false);
    expect(panels.view.getState()).toEqual([]);
  });

  it('is one panel however often the legend is set open, and a new registration each time it opens again', () => {
    const { state, panels } = bound();
    state.presentation.setLegendOpen(true);
    state.presentation.setLegendOpen(true);
    expect(panels.view.getState()).toHaveLength(1);
    const first = panels.view.getState()[0]?.registration;
    state.presentation.setLegendOpen(false);
    state.presentation.setLegendOpen(true);
    expect(panels.view.getState()[0]?.registration).toBe((first ?? 0) + 1);
  });

  it('is registered at once when the legend is already open when the binder starts, and survives another source being bound', () => {
    const state = createClientState();
    state.presentation.setLegendOpen(true);
    const panels = createPanelRegistry();
    bindLegend(state, panels);
    expect(panels.view.getState().map((panel) => panel.id)).toEqual([LEGEND_PANEL_ID]);
    state.bindSource('source-a');
    state.bindSource('source-b');
    expect(panels.view.getState().map((panel) => panel.id)).toEqual([LEGEND_PANEL_ID]);
  });

  it('is taken out, and no longer followed, when the binder is stopped', () => {
    const { state, panels, unbind } = bound();
    state.presentation.setLegendOpen(true);
    unbind();
    expect(panels.view.getState()).toEqual([]);
    state.presentation.setLegendOpen(false);
    state.presentation.setLegendOpen(true);
    expect(panels.view.getState()).toEqual([]);
  });

  it('leaves a panel that something else registered under another ID alone', () => {
    const { state, panels } = bound();
    panels.register({ id: 'other', title: 'Other', placement: { kind: 'dock' }, content: () => null });
    state.presentation.setLegendOpen(true);
    state.presentation.setLegendOpen(false);
    expect(panels.view.getState().map((panel) => panel.id)).toEqual(['other']);
  });
});

describe('the legend\'s panel and the state of its panel', () => {
  it('is taken out with its collapsed state cleared and its size kept, and opens expanded at that size, when the legend closes', () => {
    const state = createClientState();
    const panels = createPanelRegistryFor(state);
    bindLegend(state, panels);
    state.presentation.setLegendOpen(true);
    const registration = panels.view.getState()[0]?.registration ?? 0;
    state.presentation.setPanelSize(LEGEND_PANEL_ID, 380);
    state.presentation.setPanelCollapsed(LEGEND_PANEL_ID, registration, true);
    state.presentation.setLegendOpen(false);
    expect(state.presentation.view.getState().collapsedPanels.size).toBe(0);
    expect(state.presentation.view.getState().panelSizes.get(LEGEND_PANEL_ID)).toBe(380);
    state.presentation.setLegendOpen(true);
    const next = panels.view.getState()[0]?.registration ?? 0;
    expect(next).toBeGreaterThan(registration);
    expect(state.presentation.view.getState().collapsedPanels.get(LEGEND_PANEL_ID)).toBeUndefined();
  });

  it('keeps registered, and the state open, when another source is bound: nothing in the registration belongs to a page', () => {
    const state = createClientState();
    const panels = createPanelRegistry();
    bindLegend(state, panels);
    state.presentation.setLegendOpen(true);
    expect(panels.view.getState().map((panel) => panel.id)).toEqual([LEGEND_PANEL_ID]);
    state.bindSource('source-a');
    expect(state.presentation.view.getState().legendOpen).toBe(true);
    expect(panels.view.getState().map((panel) => panel.id)).toEqual([LEGEND_PANEL_ID]);
  });
});
