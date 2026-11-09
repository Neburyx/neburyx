import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { edge } from '../state/test-data.js';
import { edgeKey } from '../state/keys.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import { createClientState } from '../state/client-state.js';
import { entity, inInspector, inspector, inspectorRig, keyOf, property, select } from './inspector-kit.js';

const selected = (state: ReturnType<typeof createClientState>): string[] => [...state.presentation.view.getState().selection];

describe('the inspector panel', () => {
  it('opens for one drawn entity with its type, title and ref, from the loaded node and before any read answers', () => {
    const rig = inspectorRig();
    expect(inspector()).toBeNull();
    select(rig.state, 'n1');
    const panel = inInspector();
    expect(panel.getByText('Kind A')).toBeTruthy();
    expect(panel.getByRole('heading', { name: 'Title n1' })).toBeTruthy();
    expect(panel.getByText('n1')).toBeTruthy();
    expect(panel.getByRole('button', { name: 'Close inspector' })).toBeTruthy();
    expect(rig.entityReads).toHaveLength(1);
  });

  it('follows the selection to another entity, and closes for none, several, a relationship and a hidden entity', () => {
    const rig = inspectorRig({ nodes: [entity('n1'), entity('n2'), entity('n3')] });
    loadGraph(rig.state, [entity('n1'), entity('n2'), entity('n3')], [edge('a', 'r1', 'n1', 'n2')]);
    select(rig.state, 'n1');
    expect(inInspector().getByRole('heading', { name: 'Title n1' })).toBeTruthy();
    select(rig.state, 'n2');
    expect(inInspector().getByRole('heading', { name: 'Title n2' })).toBeTruthy();
    select(rig.state, 'n1', 'n2');
    expect(inspector()).toBeNull();
    select(rig.state, 'n1');
    expect(inspector()).not.toBeNull();
    act(() => rig.state.presentation.select([]));
    expect(inspector()).toBeNull();
    act(() => rig.state.presentation.select([edgeKey({ sourceId: 'a', type: 'rel-a', from: 'type-a', to: 'type-a', stableId: 'r1' })]));
    expect(inspector()).toBeNull();
    select(rig.state, 'n3');
    expect(inspector()).not.toBeNull();
    act(() => rig.state.hide([keyOf('n3')]));
    expect(inspector()).toBeNull();
  });

  it('closes with the close button, puts the focus on the canvas, keeps the selection and stays closed until another entity is selected', async () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    await userEvent.setup().click(inInspector().getByRole('button', { name: 'Close inspector' }));
    expect(inspector()).toBeNull();
    expect(document.activeElement).toBe(document.querySelector('.graph-canvas'));
    expect(selected(rig.state)).toEqual([keyOf('n1')]);
    act(() => rig.state.presentation.select([keyOf('n1')]));
    expect(inspector()).toBeNull();
    select(rig.state, 'n2');
    expect(inspector()).not.toBeNull();
  });

  it('closes on Escape inside it without clearing the selection', async () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    await user.keyboard('{Escape}');
    expect(inspector()).toBeNull();
    expect(selected(rig.state)).toEqual([keyOf('n1')]);
    expect(document.activeElement).toBe(document.querySelector('.graph-canvas'));
  });

  it('opens when the selection changes without taking the focus', () => {
    const rig = inspectorRig();
    const outside = screen.getByRole('button', { name: 'Outside' });
    outside.focus();
    select(rig.state, 'n1');
    expect(inspector()).not.toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it('closes when an entity type that filters it out is switched off', () => {
    const rig = inspectorRig();
    rig.state.presentation.setMappedTypes({ entityTypes: ['type-a'], relationshipTypes: [] });
    select(rig.state, 'n1');
    act(() => rig.state.setEntityTypeOff('type-a', true));
    expect(inspector()).toBeNull();
  });

  it('closes when another source is bound', () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    act(() => rig.state.bindSource('b'));
    expect(inspector()).toBeNull();
  });

  it('closes when the masking setting changes', () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    act(() => rig.state.setMask(true));
    expect(inspector()).toBeNull();
  });

  it('draws the Overview and Properties tabs, marks the selected one and moves between them with the arrow keys', async () => {
    const rig = inspectorRig({ nodes: [entity('n1', [property('holder', 'Jordan')])] });
    select(rig.state, 'n1');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Overview', 'Properties']);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    const user = userEvent.setup();
    tabs[0]?.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Properties' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Properties' })).toBe(document.activeElement);
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows a tab that a later feature registers in its place', () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    let remove = (): void => undefined;
    act(() => {
      remove = rig.inspector.tabs.register({ id: 'relationships', label: 'Relationships', order: 15, content: () => <p>Later</p> });
    });
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Overview', 'Relationships', 'Properties']);
    act(() => remove());
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('lays the Legend left of the inspector while both are open and puts it back when the inspector closes', () => {
    const rig = inspectorRig();
    act(() => rig.state.presentation.setLegendOpen(true));
    const legendInset = (): unknown => {
      const placement = rig.panels.view.getState().find((panel) => panel.id === 'legend')?.placement;
      return placement?.kind === 'floating' ? placement.inset : undefined;
    };
    expect(legendInset()).toBeUndefined();
    select(rig.state, 'n1');
    expect(legendInset()).toBeGreaterThan(300);
    act(() => rig.state.presentation.select([]));
    expect(legendInset()).toBeUndefined();
  });

  it('moves the Legend again when the inspector is resized', () => {
    const rig = inspectorRig();
    act(() => rig.state.presentation.setLegendOpen(true));
    select(rig.state, 'n1');
    const legendInset = (): number | undefined => {
      const placement = rig.panels.view.getState().find((panel) => panel.id === 'legend')?.placement;
      return placement?.kind === 'floating' ? placement.inset : undefined;
    };
    const before = legendInset() ?? 0;
    act(() => rig.state.presentation.setPanelSize('inspector', 400));
    expect(legendInset()).toBe(before + 80);
  });

  it('is taken out when the binding stops', () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    rig.unbind();
    expect(rig.panels.view.getState().some((panel) => panel.id === 'inspector')).toBe(false);
    vi.clearAllMocks();
  });
});
