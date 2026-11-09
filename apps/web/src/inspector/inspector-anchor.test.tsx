import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { edgeKey } from '../state/keys.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import { entity, inInspector, inspector, inspectorRig, keyOf, select } from './inspector-kit.js';
import { openRelationships, openTab, stored } from './relationship-kit.js';

const r1 = edgeKey(stored('r1', 'n1', 'n2').ref);
const r3 = edgeKey(stored('r3', 'n2', 'n3').ref);
const pick = (rig: { readonly state: { readonly presentation: { select(keys: readonly string[]): void } } }, ...keys: string[]): void => void act(() => rig.state.presentation.select(keys));
const shownTitle = (): string | undefined => inInspector().queryByRole('heading', { level: 2 })?.textContent ?? undefined;

describe('the inspector stays on its entity while one of its relationships is selected', () => {
  it('stays open on the entity when a row selects a relationship, with the focus on the row', async () => {
    const rig = await openRelationships([stored('r1', 'n1', 'n2')]);
    const row = screen.getAllByRole('button').find((button) => button.classList.contains('relationship-row')) as HTMLElement;
    await userEvent.setup().click(row);
    expect([...rig.state.presentation.view.getState().selection]).toEqual([r1]);
    expect(inspector()).not.toBeNull();
    expect(inInspector().getByRole('heading', { name: 'Title n1' })).toBeTruthy();
    expect(document.activeElement).toBe(row);
  });

  it('stays open when the relationship is selected on the canvas, not from a row', async () => {
    const rig = await openRelationships([stored('r1', 'n1', 'n2')]);
    pick(rig, r1);
    expect(inInspector().getByRole('heading', { name: 'Title n1' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Relationships' }).getAttribute('aria-selected')).toBe('true');
  });

  it('closes for a relationship that does not have the shown entity as an end', async () => {
    const rig = await openRelationships([stored('r1', 'n1', 'n2'), stored('r3', 'n2', 'n3')]);
    pick(rig, r3);
    expect(inspector()).toBeNull();
  });

  it('closes for none, for several elements and for another entity, and a relationship selected after none does not open it', async () => {
    const rig = await openRelationships([stored('r1', 'n1', 'n2')]);
    pick(rig, r1, keyOf('n1'));
    expect(inspector()).toBeNull();
    pick(rig, r1);
    expect(inspector()).toBeNull();
    select(rig.state, 'n1');
    pick(rig, r1);
    expect(shownTitle()).toBe('Title n1');
    pick(rig);
    expect(inspector()).toBeNull();
    pick(rig, r1);
    expect(inspector()).toBeNull();
    select(rig.state, 'n2');
    expect(shownTitle()).toBe('Title n2');
  });

  it('closes when the entity it shows is hidden while its relationship is selected', async () => {
    const rig = await openRelationships([stored('r1', 'n1', 'n2')]);
    pick(rig, r1);
    act(() => rig.state.hide([keyOf('n1')]));
    expect(inspector()).toBeNull();
  });

  it('closes on Esc with the relationship still selected, and stays closed while a relationship of that entity is selected', async () => {
    const rig = await openRelationships([stored('r1', 'n1', 'n2'), stored('r2', 'n1', 'n3')]);
    pick(rig, r1);
    inInspector().getByRole('tab', { name: 'Relationships' }).focus();
    await userEvent.setup().keyboard('{Escape}');
    expect(inspector()).toBeNull();
    expect([...rig.state.presentation.view.getState().selection]).toEqual([r1]);
    pick(rig, edgeKey(stored('r2', 'n1', 'n3').ref));
    expect(inspector()).toBeNull();
  });

  it('after a close with the entity selected, stays closed for its relationship, opens again when the same entity is selected after none, and opens for another entity', async () => {
    const rig = await openRelationships([stored('r1', 'n1', 'n2')]);
    await userEvent.setup().click(inInspector().getByRole('button', { name: 'Close inspector' }));
    pick(rig, r1);
    expect(inspector()).toBeNull();
    pick(rig);
    select(rig.state, 'n1');
    expect(inspector()).not.toBeNull();
    await userEvent.setup().click(inInspector().getByRole('button', { name: 'Close inspector' }));
    select(rig.state, 'n2');
    expect(shownTitle()).toBe('Title n2');
  });

  it('closes when the masking setting changes while a relationship is selected', async () => {
    const rig = await openRelationships([stored('r1', 'n1', 'n2')]);
    pick(rig, r1);
    act(() => rig.state.setMask(true));
    expect(inspector()).toBeNull();
  });

  it('closes when another source is bound while a relationship is selected', async () => {
    const rig = await openRelationships([stored('r1', 'n1', 'n2')]);
    pick(rig, r1);
    act(() => rig.state.bindSource('b'));
    expect(inspector()).toBeNull();
  });

  it('closes when the investigation changes the loaded graph so the relationship is gone', async () => {
    const rig = inspectorRig({ nodes: [entity('n1'), entity('n2')] });
    loadGraph(rig.state, [entity('n1'), entity('n2')], [stored('r1', 'n1', 'n2')]);
    select(rig.state, 'n1');
    await openTab();
    pick(rig, r1);
    act(() => loadGraph(rig.state, [entity('n1'), entity('n2')], []));
    expect(inspector()).toBeNull();
  });
});
