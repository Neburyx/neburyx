import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { clientWith, me, renderApp, source } from '../test-utils.js';
import { registerBuiltInSlots } from './built-in-slots.js';
import { createSlotRegistry } from './slots.js';

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

  it('show no zoom controls when they are not registered', () => {
    renderApp('/explore', client);
    expect(screen.queryByRole('group', { name: 'Zoom' })).toBeNull();
  });
});
