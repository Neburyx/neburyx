import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { registerBuiltInTools } from './built-in-tools.js';
import { createToolRegistry, ToolsProvider } from './tool-registry.js';
import { ToolStrip } from './tool-strip.js';

function show(state: ClientState = createClientState(), activate: () => void = () => undefined) {
  const tools = createToolRegistry();
  registerBuiltInTools(tools);
  tools.register({ id: 'panel', label: 'Panel', icon: null, order: 20, kind: { type: 'action', activate } });
  render(
    <ClientStateProvider state={state}>
      <ToolsProvider registry={tools}>
        <ToolStrip />
        <button type="button">After</button>
      </ToolsProvider>
    </ClientStateProvider>,
  );
  return state;
}

const explore = (): HTMLElement => screen.getByRole('button', { name: 'Explore' });
const menu = (): HTMLElement => screen.getByRole('menu', { name: 'Explore' });
const item = (name: string): HTMLElement => within(menu()).getByRole(['Select', 'Pan', 'Box select'].includes(name) ? 'menuitemradio' : 'menuitem', { name });
const focused = (): string | null => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? null;
const focusedItem = (): string => {
  const rows = [...within(menu()).getAllByRole('menuitemradio'), ...within(menu()).getAllByRole('menuitem')];
  return rows.find((row) => row === document.activeElement)?.querySelector('.tool-flyout-label')?.textContent ?? 'none';
};

describe('the tool strip from the keyboard', () => {
  it('takes the focus button by button in the strip order, each named by its tool, and presses with Enter and Space', async () => {
    const activate = vi.fn();
    show(createClientState(), activate);
    const user = userEvent.setup();
    await user.tab();
    expect(focused()).toBe('Explore');
    await user.tab();
    expect(focused()).toBe('Panel');
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(activate).toHaveBeenCalledTimes(2);
    await user.tab();
    expect(focused()).toBe('After');
  });

  it('marks a flyout tool as opening a menu and as expanded only while its flyout is open, and marks an action tool as neither', async () => {
    show();
    const user = userEvent.setup();
    expect(explore().getAttribute('aria-haspopup')).toBe('menu');
    expect(explore().getAttribute('aria-expanded')).toBe('false');
    const panel = screen.getByRole('button', { name: 'Panel' });
    expect(panel.getAttribute('aria-haspopup')).toBeNull();
    expect(panel.getAttribute('aria-expanded')).toBeNull();
    explore().focus();
    await user.keyboard('{Enter}');
    expect(explore().getAttribute('aria-expanded')).toBe('true');
    expect(panel.getAttribute('aria-expanded')).toBeNull();
  });

  it('moves the focus to the row of the current mode when the flyout opens, from the keyboard and from the pointer', async () => {
    const state = show();
    const user = userEvent.setup();
    explore().focus();
    await user.keyboard('{Enter}');
    expect(focusedItem()).toBe('Select');
    await user.keyboard('{Escape}');
    state.presentation.setTool('box');
    await user.click(explore());
    expect(focusedItem()).toBe('Box select');
  });

  it('moves the focus between the rows with the arrow keys, Home and End, wrapping at the ends, and not with the pointer', async () => {
    show();
    const user = userEvent.setup();
    explore().focus();
    await user.keyboard('{Enter}');
    const down: string[] = [];
    for (let step = 0; step < 6; step += 1) {
      await user.keyboard('{ArrowDown}');
      down.push(focusedItem());
    }
    expect(down).toEqual(['Pan', 'Box select', 'Select all', 'Invert selection', 'Clear selection', 'Select']);
    await user.keyboard('{ArrowUp}');
    expect(focusedItem()).toBe('Clear selection');
    await user.keyboard('{Home}');
    expect(focusedItem()).toBe('Select');
    await user.keyboard('{End}');
    expect(focusedItem()).toBe('Clear selection');
    await user.hover(item('Pan'));
    expect(focusedItem()).toBe('Clear selection');
  });

  it('chooses the row that has the focus with Enter or Space and puts the focus back on the button', async () => {
    const state = show();
    const user = userEvent.setup();
    explore().focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(state.presentation.view.getState().tool).toBe('pan');
    expect(screen.queryByRole('menu', { name: 'Explore' })).toBeNull();
    expect(document.activeElement).toBe(explore());
    await user.keyboard('{Enter}');
    expect(focusedItem()).toBe('Pan');
    await user.keyboard('{Home} ');
    expect(state.presentation.view.getState().tool).toBe('select');
    expect(document.activeElement).toBe(explore());
  });

  it('closes on Escape and puts the focus on the button, and on Tab moves on from the button', async () => {
    const state = show();
    const user = userEvent.setup();
    explore().focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: 'Explore' })).toBeNull();
    expect(document.activeElement).toBe(explore());
    await user.keyboard('{Enter}');
    await user.tab();
    expect(screen.queryByRole('menu', { name: 'Explore' })).toBeNull();
    expect(focused()).toBe('Panel');
    expect(state.presentation.view.getState().tool).toBe('select');
  });

  it('is a menu named Explore with three radio rows that say which is chosen, three plain rows and one separator, and no hint in a name', async () => {
    show();
    explore().focus();
    await userEvent.setup().keyboard('{Enter}');
    const radios = within(menu()).getAllByRole('menuitemradio');
    expect(radios.map((row) => [row.getAttribute('aria-label') ?? row.textContent, row.getAttribute('aria-checked')])).toEqual([['SelectV', 'true'], ['PanH', 'false'], ['Box selectB', 'false']]);
    expect(within(menu()).getByRole('menuitemradio', { name: 'Select' })).toBe(radios[0]);
    expect(within(menu()).getAllByRole('menuitem').map((row) => row.querySelector('.tool-flyout-label')?.textContent)).toEqual(['Select all', 'Invert selection', 'Clear selection']);
    expect(within(menu()).getAllByRole('separator')).toHaveLength(1);
    for (const hint of ['V', 'H', 'B', '⌘A', '⇧⌘I', 'Esc']) expect(within(menu()).queryByRole('menuitem', { name: new RegExp(`${hint}$`) })).toBeNull();
  });
});
