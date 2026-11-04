import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { clientWith, me, renderApp, source } from '../test-utils.js';
import { registerBuiltInSlots } from './built-in-slots.js';
import { registerBuiltInTools } from './built-in-tools.js';
import { createSlotRegistry } from './slots.js';
import { createToolRegistry } from './tool-registry.js';

const client = clientWith({ me: me(), sources: [source('a')] });

describe('the controls the workspace provides', () => {
  it('put the zoom controls in their slot, so Explore shows them, and take them out again', () => {
    const slots = createSlotRegistry();
    const remove = registerBuiltInSlots(slots);
    const { unmount } = renderApp('/explore', client, undefined, slots);
    expect(screen.getByRole('group', { name: 'Zoom' })).not.toBeNull();
    unmount();
    remove();
    expect(slots.view.getState().has('zoom-controls')).toBe(false);
  });

  it('put the tool strip in its slot with Explore as the one tool, so Explore shows it, and take it out again', () => {
    const slots = createSlotRegistry();
    const remove = registerBuiltInSlots(slots);
    const tools = createToolRegistry();
    registerBuiltInTools(tools);
    const { unmount } = renderApp('/explore', client, undefined, slots, undefined, undefined, tools);
    const strip = screen.getByRole('group', { name: 'Tools' });
    expect(within(strip).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Explore']);
    unmount();
    remove();
    expect(slots.view.getState().has('tool-strip')).toBe(false);
    expect(slots.view.getState().has('zoom-controls')).toBe(false);
  });

  it('show no tool strip when it is not registered', () => {
    renderApp('/explore', client);
    expect(screen.queryByRole('group', { name: 'Tools' })).toBeNull();
  });

  it('show no zoom controls when they are not registered', () => {
    renderApp('/explore', client);
    expect(screen.queryByRole('group', { name: 'Zoom' })).toBeNull();
  });
});
