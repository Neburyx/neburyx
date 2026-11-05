import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WALK_SENTENCE } from '../canvas/graph-canvas.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { builtInKeyBindings, canvasSummary, clientWith, me, renderApp, source, stubFactory } from '../test-utils.js';
import { registerBuiltInMenuItems } from './built-in-menu-items.js';
import { registerBuiltInSlots } from './built-in-slots.js';
import { registerBuiltInTools } from './built-in-tools.js';
import { load } from './context-menu-kit.js';
import { createMenuRegistry } from './menu-registry.js';
import { createSlotRegistry } from './slots.js';
import { createToolRegistry } from './tool-registry.js';

const client = clientWith({ me: me(), sources: [source('a')] });

afterEach(cleanup);

function workspace(state: ClientState = createClientState()) {
  const slots = createSlotRegistry();
  registerBuiltInSlots(slots);
  const tools = createToolRegistry();
  registerBuiltInTools(tools);
  const menus = createMenuRegistry();
  registerBuiltInMenuItems(menus);
  renderApp('/explore', client, state, slots, stubFactory().create, undefined, tools, menus, undefined, builtInKeyBindings());
  return screen.getByRole('application', { name: 'Graph canvas' });
}

const loaded = (): ClientState => {
  const state = createClientState();
  load(state);
  return state;
};

describe('the canvas as a tab stop', () => {
  it.each([
    ['with nothing loaded', createClientState],
    ['with a graph loaded', loaded],
  ])('is one tab stop in the canvas key scope, named "Graph canvas", and described with how to walk it, %s', async (_name, make) => {
    const canvas = workspace(make());
    await act(async () => void (await Promise.resolve()));
    expect(canvas.tabIndex).toBe(0);
    expect(canvas.getAttribute('data-key-scope')).toBe('canvas');
    expect(screen.getAllByRole('application')).toHaveLength(1);
    expect(document.getElementById(canvas.getAttribute('aria-describedby') ?? '')?.textContent).toContain(WALK_SENTENCE);
    expect(canvasSummary(canvas)).toMatch(/^\d+ entit(y|ies) and \d+ relationships? loaded/);
  });

  it.each([
    ['with nothing loaded', createClientState],
    ['with a graph loaded', loaded],
  ])('lets the focus go on with Tab and back with Shift+Tab, so it is not a keyboard trap, %s', async (_name, make) => {
    const canvas = workspace(make());
    await act(async () => void (await Promise.resolve()));
    const user = userEvent.setup();
    act(() => canvas.focus());
    expect(document.activeElement).toBe(canvas);
    await user.tab();
    expect(document.activeElement).not.toBe(canvas);
    expect(document.activeElement).not.toBe(document.body);
    act(() => canvas.focus());
    await user.tab({ shift: true });
    expect(document.activeElement).not.toBe(canvas);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('takes the focus when a mouse press is released, which the renderer blurs on its own at the press, and gives it up when the focus moves on', async () => {
    const canvas = workspace(loaded());
    await act(async () => void (await Promise.resolve()));
    expect(document.activeElement).not.toBe(canvas);
    fireEvent.mouseUp(canvas);
    expect(document.activeElement).toBe(canvas);
    act(() => canvas.blur());
    expect(document.activeElement).not.toBe(canvas);
  });
});

describe('the focus ring of the canvas', () => {
  it('is the keyboard focus outline, drawn inside the canvas so the region does not clip it, and no rule turns it off', () => {
    const css = readFileSync(join(__dirname, '..', 'styles', 'workspace.css'), 'utf8');
    expect(css).toMatch(/\.graph-canvas:focus-visible \{[^}]*outline-offset: calc\(-1 \* var\(--focus-width\)\);/s);
    expect(css).not.toMatch(/\.graph-canvas[^{]*:focus[^{]*\{[^}]*outline:\s*(none|0)/s);
  });
});
