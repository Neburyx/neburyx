import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { registerStandIns } from '../dev/stand-ins.js';
import { clientWith, me, renderApp, source } from '../test-utils.js';
import { createSlotRegistry, SlotError, type SlotName } from './slots.js';

const client = clientWith({ me: me(), sources: [source('a')] });

describe('the slot registry', () => {
  it('puts a component in a slot, and takes it out again with the function it returns', () => {
    const registry = createSlotRegistry();
    const occupant = () => null;
    const remove = registry.register('toggles', occupant);
    expect(registry.view.getState().get('toggles')).toBe(occupant);
    remove();
    expect(registry.view.getState().has('toggles')).toBe(false);
  });

  it('refuses a second registration of a name with the named error, and keeps the first', () => {
    const registry = createSlotRegistry();
    const first = () => null;
    registry.register('save', first);
    expect(() => registry.register('save', () => null)).toThrow(SlotError);
    expect(() => registry.register('save', () => null)).toThrow('SLOT_TAKEN');
    expect(registry.view.getState().get('save')).toBe(first);
  });

  it('takes out only its own registration: a stale remover does nothing once the slot is taken again, even by the same component', () => {
    const registry = createSlotRegistry();
    const occupant = () => null;
    const remove = registry.register('export', occupant);
    remove();
    registry.register('export', occupant);
    remove();
    expect(registry.view.getState().get('export')).toBe(occupant);
  });

});

const REGIONS: readonly (readonly [SlotName, string, string])[] = [
  ['tool-strip', 'Tools', 'region-tool-strip'],
  ['toggles', 'Toggles', 'region-toggles'],
  ['zoom-controls', 'Zoom', 'region-zoom-controls'],
];

describe('Explore with nothing registered', () => {
  it('has no canvas region, no extra destination and no empty box where a slot would be', async () => {
    const { container } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    expect(container.querySelectorAll('.region')).toHaveLength(0);
    expect(within(screen.getByRole('navigation', { name: 'Workspace' })).getAllByRole('link')).toHaveLength(3);
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Ask, locked', 'Summarize, locked']);
    for (const name of ['Views ▾', 'Export', 'Save', 'Investigation menu', 'Settings']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Search' })).toBeNull();
  });
});

describe('Explore with occupants registered', () => {
  it.each(REGIONS)('draws the %s occupant in its own region', async (slot, name, region) => {
    const { slots } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    act(() => {
      slots.register(slot, () => <p>{name}</p>);
    });
    expect(screen.getByText(name).parentElement?.className).toBe(`region ${region}`);
  });

  it('draws the floating occupant in a layer over the canvas', async () => {
    const { slots } = renderApp('/explore', client);
    act(() => {
      slots.register('floating', () => <p>Layer</p>);
    });
    expect(screen.getByText('Layer').parentElement?.className).toBe('region region-floating');
  });

  it('puts Search between Home and Investigations and the settings destination below the destinations', async () => {
    const { slots } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    act(() => {
      registerStandIns(slots);
    });
    const rail = screen.getByRole('navigation', { name: 'Workspace' });
    expect(within(rail).getAllByRole('link')).toHaveLength(4);
    expect(within(rail).getAllByRole('link').map((link) => link.getAttribute('aria-label'))).toEqual(['Home', 'Search', 'Investigations', 'Sources']);
    const settings = screen.getByRole('button', { name: 'Settings' });
    expect(rail.contains(settings)).toBe(false);
    expect(rail.parentElement?.contains(settings)).toBe(true);
  });

  it('shows a slot registered while Explore is shown, and removes it again, without touching the other regions', async () => {
    const { slots } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    let removeToggles: () => void = () => undefined;
    act(() => {
      slots.register('tool-strip', () => <p>Tools</p>);
      removeToggles = slots.register('toggles', () => <p>Toggles</p>);
    });
    const tools = screen.getByText('Tools');
    expect(screen.getByText('Toggles')).toBeTruthy();
    act(() => removeToggles());
    expect(screen.queryByText('Toggles')).toBeNull();
    expect(screen.getByText('Tools')).toBe(tools);
  });
});
