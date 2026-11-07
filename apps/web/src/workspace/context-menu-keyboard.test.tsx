import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClientState, type ClientState } from '../state/client-state.js';
import { edgeKey } from '../state/keys.js';
import { edge, node } from '../state/test-data.js';
import { commandItem, load, loadGraph, nodeKey, onCanvas, selection, show, withBuiltIns, type CommandOptions } from './context-menu-kit.js';
import { createMenuRegistry, type MenuItem, type MenuItemState, type MenuRegistry, type SubmenuProps } from './menu-registry.js';

const command = (id: string, order: number, extra: CommandOptions = {}): MenuItem => commandItem(id, { ...extra, order });
const parent = (id: string, content: ComponentType<SubmenuProps>, order: number, state?: MenuItemState): MenuItem => ({ id, label: id, icon: null, group: 10, order, submenu: content, ...(state === undefined ? {} : { state }) });
const registryOf = (...items: MenuItem[]): MenuRegistry => {
  const registry = createMenuRegistry();
  for (const item of items) registry.register('canvas', item);
  return registry;
};
const Probe = ({ close }: SubmenuProps) => (
  <div>
    <button type="button" onClick={close}>
      Inside
    </button>
    <button type="button">Second inside</button>
  </div>
);
const standalone = (label: string): HTMLButtonElement => {
  const button = document.createElement('button');
  button.textContent = label;
  document.body.append(button);
  return button;
};
const row = (name: string | RegExp): HTMLElement => screen.getByRole('menuitem', { name });
const focusedName = (): string | null => {
  const active = document.activeElement;
  return active?.getAttribute('role') === 'menuitem' ? (active.querySelector('.menu-label')?.textContent ?? null) : (active?.textContent ?? null);
};
const open = (registry: MenuRegistry) => {
  const state = createClientState();
  load(state);
  const shown = show(state, {}, registry);
  return { state, ...shown };
};
const openFromOutside = async (registry: MenuRegistry) => {
  const opened = open(registry);
  act(() => screen.getByRole('button', { name: 'Outside' }).focus());
  return opened;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the menu from the keyboard', () => {
  it('is a menu named Canvas with menu items and separators, and puts the focus on the first enabled item', () => {
    const registry = withBuiltIns();
    registry.register('canvas', command('Other group', 10, { group: 20 }));
    const { rightClick } = open(registry);
    rightClick(onCanvas(10, 10));
    expect(screen.getByRole('menu', { name: 'Canvas' })).not.toBeNull();
    expect(screen.getAllByRole('menuitem')).toHaveLength(6);
    expect(screen.getAllByRole('separator')).toHaveLength(2);
    expect(focusedName()).toBe('Fit to view');
  });

  it('focuses the first item that is enabled, the first item when none is, and the menu itself when it has no items', () => {
    const first = open(registryOf(command('Off', 10, { state: 'disabled' }), command('On', 20)));
    first.rightClick(onCanvas(10, 10));
    expect(focusedName()).toBe('On');
    cleanup();
    const second = open(registryOf(command('Off', 10, { state: 'disabled' }), command('Also off', 20, { state: 'disabled' })));
    second.rightClick(onCanvas(10, 10));
    expect(focusedName()).toBe('Off');
    cleanup();
    const state = createClientState();
    loadGraph(state, [node('a', 'n1'), node('a', 'n2')], [edge('a', 'e1', 'n1', 'n2')]);
    const empty = show(state, {}, createMenuRegistry());
    empty.rightClick({ target: { kind: 'node', key: nodeKey('n1') }, x: 5, y: 5 });
    expect(document.activeElement).toBe(screen.getByRole('menu', { name: 'n1' }));
    empty.rightClick({ target: { kind: 'relationship', key: edgeKey(edge('a', 'e1', 'n1', 'n2').ref) }, x: 5, y: 5 });
    expect(screen.getByRole('menu')).toBe(document.activeElement);
  });

  it('moves the focus with ArrowDown, ArrowUp, Home and End over every item, wrapping, and not with the pointer', async () => {
    const { rightClick } = open(withBuiltIns());
    rightClick(onCanvas(10, 10));
    const user = userEvent.setup();
    const down: (string | null)[] = [];
    for (let step = 0; step < 4; step += 1) {
      await user.keyboard('{ArrowDown}');
      down.push(focusedName());
    }
    expect(down).toEqual(['Select all', 'Invert selection', 'Layout', 'Show legend']);
    await user.keyboard('{ArrowUp}');
    expect(focusedName()).toBe('Layout');
    await user.keyboard('{Home}');
    expect(focusedName()).toBe('Fit to view');
    await user.keyboard('{End}');
    expect(focusedName()).toBe('Show legend');
    await user.hover(row('Select all'));
    expect(focusedName()).toBe('Show legend');
  });

  it('lets the focus reach a disabled item, which does nothing', async () => {
    const run = vi.fn();
    const { rightClick } = open(registryOf(command('On', 10), command('Off', 20, { state: 'disabled', run })));
    rightClick(onCanvas(10, 10));
    const user = userEvent.setup();
    await user.keyboard('{ArrowDown}');
    expect(focusedName()).toBe('Off');
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(run).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeNull();
    expect(focusedName()).toBe('Off');
  });

  it('runs an enabled command with Enter or Space, closes, and returns the focus to the element that had it when the menu opened', async () => {
    const run = vi.fn();
    const { rightClick } = await openFromOutside(registryOf(command('Act', 10, { run }), command('Again', 20, { run })));
    rightClick(onCanvas(10, 10));
    const user = userEvent.setup();
    await user.keyboard('{Enter}');
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Outside' }));
    rightClick(onCanvas(10, 10));
    await user.keyboard('{ArrowDown} ');
    expect(run).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Outside' }));
  });

  it('moves no focus when the element that had it is gone', async () => {
    const { rightClick } = open(registryOf(command('Act', 10)));
    const outsider = standalone('Outsider');
    act(() => outsider.focus());
    rightClick(onCanvas(10, 10));
    outsider.remove();
    await userEvent.setup().keyboard('{Enter}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('opens the content of a submenu item with ArrowRight, Enter or Space and puts the focus inside it, leaving the menu open', async () => {
    const { rightClick } = open(registryOf(parent('More', Probe, 10), command('Other', 20)));
    const user = userEvent.setup();
    for (const keys of ['{ArrowRight}', '{Enter}', ' ']) {
      rightClick(onCanvas(10, 10));
      await user.keyboard(keys);
      expect(screen.getByRole('button', { name: 'Inside' })).not.toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Inside' }));
      expect(screen.queryAllByRole('menu')).toHaveLength(1);
    }
  });

  it('takes the focus into a submenu opened with the mouse without a ring, and moves between its buttons with the arrow keys', async () => {
    const { rightClick } = open(registryOf(parent('More', Probe, 10), command('Other', 20)));
    const calls: Array<{ target: HTMLElement; focusVisible: boolean | undefined }> = [];
    const original = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions & { focusVisible?: boolean }) {
      calls.push({ target: this, focusVisible: options?.focusVisible });
      return original.call(this, options);
    };
    try {
      rightClick(onCanvas(10, 10));
      const user = userEvent.setup();
      await user.click(row('More'));
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Inside' }));
      expect(calls.filter((call) => call.target === document.activeElement).every((call) => call.focusVisible === false)).toBe(true);
      await user.keyboard('{ArrowDown}');
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Second inside' }));
      await user.keyboard('{ArrowDown}');
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Inside' }));
      await user.keyboard('{End}');
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Second inside' }));
    } finally {
      HTMLElement.prototype.focus = original;
    }
  });

  it('shows the ring of a keyboard opening that follows a press which never became a click', async () => {
    const { rightClick } = open(registryOf(parent('More', Probe, 10), command('Other', 20)));
    const calls: Array<{ target: HTMLElement; focusVisible: boolean | undefined }> = [];
    const original = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions & { focusVisible?: boolean }) {
      calls.push({ target: this, focusVisible: options?.focusVisible });
      return original.call(this, options);
    };
    try {
      rightClick(onCanvas(10, 10));
      const user = userEvent.setup();
      await user.pointer({ keys: '[MouseLeft>]', target: row('Other') });
      row('More').focus();
      await user.keyboard('{ArrowRight}');
      const inside = calls.filter((call) => call.target === screen.getByRole('button', { name: 'Inside' }));
      expect(inside.length).toBeGreaterThan(0);
      expect(inside.every((call) => call.focusVisible !== false)).toBe(true);
    } finally {
      HTMLElement.prototype.focus = original;
    }
  });

  it('closes only the submenu with ArrowLeft or Escape and puts the focus back on its item, then Escape closes the menu and returns the focus', async () => {
    const { rightClick } = await openFromOutside(registryOf(parent('More', Probe, 10), command('Other', 20)));
    rightClick(onCanvas(10, 10));
    const user = userEvent.setup();
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{ArrowLeft}');
    expect(screen.queryByRole('button', { name: 'Inside' })).toBeNull();
    expect(focusedName()).toBe('More');
    expect(screen.queryByRole('menu')).not.toBeNull();
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Inside' })).toBeNull();
    expect(focusedName()).toBe('More');
    expect(screen.queryByRole('menu')).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Outside' }));
  });

  it('does nothing with Enter, Space or ArrowRight on a disabled submenu item, keeps the menu open and the focus where it is', async () => {
    const { rightClick } = open(registryOf(parent('More', Probe, 10, 'disabled'), command('Other', 20)));
    rightClick(onCanvas(10, 10));
    const user = userEvent.setup();
    expect(focusedName()).toBe('Other');
    await user.keyboard('{ArrowUp}');
    expect(focusedName()).toBe('More');
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    await user.keyboard('{ArrowRight}');
    expect(screen.queryByRole('button', { name: 'Inside' })).toBeNull();
    expect(screen.queryByRole('menu')).not.toBeNull();
    expect(focusedName()).toBe('More');
  });

  it('closes on Tab and the focus moves on from the element that had it, and moves nowhere when that element is gone', async () => {
    const { rightClick } = open(registryOf(command('Act', 10)));
    const before = standalone('Before');
    const after = standalone('After');
    const user = userEvent.setup();
    act(() => before.focus());
    rightClick(onCanvas(10, 10));
    await user.tab();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(after);
    rightClick(onCanvas(10, 10));
    after.remove();
    await user.keyboard('{Tab}');
    expect(screen.queryByRole('menu')).toBeNull();
    before.remove();
  });

  it('keeps the shortcut hint out of an item name, and says an unavailable item is unavailable', () => {
    const registry = withBuiltIns();
    registry.register('canvas', command('Unavailable', 40, { group: 30, state: 'disabled' }));
    const { rightClick } = open(registry);
    rightClick(onCanvas(10, 10));
    for (const name of ['Fit to view', 'Select all', 'Invert selection']) expect(within(screen.getByRole('menu')).getByRole('menuitem', { name })).not.toBeNull();
    expect(row('Unavailable').getAttribute('aria-disabled')).toBe('true');
    expect(row('Fit to view').getAttribute('aria-disabled')).toBeNull();
  });

  it('leaves the selection alone with the keys that only move the focus', async () => {
    const state: ClientState = createClientState();
    load(state);
    act(() => state.presentation.select([nodeKey('n1')]));
    const shown = show(state, {}, withBuiltIns());
    shown.rightClick(onCanvas(10, 10));
    await userEvent.setup().keyboard('{ArrowDown}{ArrowDown}{Home}{End}');
    expect(selection(state)).toEqual([nodeKey('n1')]);
  });

  it('moves the focus into a submenu to the first control that can take it, and leaves the submenu rows out of the menu traversal', async () => {
    const Mixed = () => (
      <div>
        <button type="button" disabled>
          Off
        </button>
        <button type="button" role="menuitem">
          Nested row
        </button>
      </div>
    );
    const { rightClick } = open(registryOf(parent('More', Mixed, 10), command('Other', 20)));
    rightClick(onCanvas(10, 10));
    const user = userEvent.setup();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Nested row' }));
    await user.keyboard('{ArrowLeft}');
    await user.keyboard('{ArrowDown}');
    expect(focusedName()).toBe('Other');
    await user.keyboard('{ArrowDown}');
    expect(focusedName()).toBe('More');
  });

  it('closes the menu from the content of a submenu and returns the focus to the element that had it', async () => {
    const { rightClick } = open(registryOf(parent('More', Probe, 10)));
    const outsider = standalone('Outsider');
    act(() => outsider.focus());
    rightClick(onCanvas(10, 10));
    await userEvent.setup().keyboard('{ArrowRight}');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Inside' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(outsider);
    outsider.remove();
  });

  it('does not keep a submenu open for a parent that was taken out, so Escape closes the menu, and the same ID registered again does not open by itself', async () => {
    const registry = createMenuRegistry();
    const removeMore = registry.register('canvas', parent('More', Probe, 10));
    registry.register('canvas', command('Other', 20));
    const { rightClick } = open(registry);
    rightClick(onCanvas(10, 10));
    const user = userEvent.setup();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Inside' })).not.toBeNull();
    act(() => removeMore());
    expect(screen.queryByRole('button', { name: 'Inside' })).toBeNull();
    expect(screen.queryByRole('menu')).not.toBeNull();
    expect(focusedName()).toBe('Other');
    act(() => {
      registry.register('canvas', parent('More', Probe, 10));
    });
    expect(screen.queryByRole('button', { name: 'Inside' })).toBeNull();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('moves the focus into a submenu to the first control that can take it, skipping a hidden input and a disabled button that is in the tab order', async () => {
    const Guarded = () => (
      <div>
        <input type="hidden" />
        <button type="button" tabIndex={0} disabled>
          Disabled but in the tab order
        </button>
        <button type="button">Usable</button>
      </div>
    );
    const { rightClick } = open(registryOf(parent('More', Guarded, 10)));
    rightClick(onCanvas(10, 10));
    await userEvent.setup().keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Usable' }));
  });

  it('puts the focus on the parent row when the pointer moves away and the focused content goes, and the keys work from there', async () => {
    const { rightClick } = open(registryOf(parent('More', Probe, 10), command('Other', 20)));
    rightClick(onCanvas(10, 10));
    const user = userEvent.setup();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Inside' }));
    await user.hover(row('Other'));
    expect(screen.queryByRole('button', { name: 'Inside' })).toBeNull();
    expect(focusedName()).toBe('More');
    await user.keyboard('{ArrowDown}');
    expect(focusedName()).toBe('Other');
  });

  it('puts the focus on the parent row when focused content fails after it took the focus, and does not take it when it is elsewhere', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Breaks = () => {
      const [broken, setBroken] = useState(false);
      if (broken) throw new Error('cannot draw the submenu');
      return (
        <button type="button" onClick={() => setBroken(true)}>
          Break
        </button>
      );
    };
    const { rightClick } = open(registryOf(parent('More', Breaks, 10), command('Other', 20)));
    rightClick(onCanvas(10, 10));
    const user = userEvent.setup();
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('button', { name: 'Break' })).toBeNull();
    expect(focusedName()).toBe('More');
    await user.keyboard('{ArrowDown}');
    expect(focusedName()).toBe('Other');
    const outsider = standalone('Elsewhere');
    await user.keyboard('{ArrowUp}{ArrowRight}');
    act(() => outsider.focus());
    await user.hover(row('Other'));
    expect(document.activeElement).toBe(outsider);
    outsider.remove();
  });

  it('puts the focus on the row of the submenu that replaced the one that held it, and the keys work from there', async () => {
    const Other = () => <button type="button">Second content</button>;
    const { rightClick } = open(registryOf(parent('First', Probe, 10), parent('Second', Other, 20), command('Last', 30)));
    rightClick(onCanvas(10, 10));
    const user = userEvent.setup();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Inside' }));
    await user.hover(row('Second'));
    expect(screen.queryByRole('button', { name: 'Inside' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Second content' })).not.toBeNull();
    expect(focusedName()).toBe('Second');
    await user.keyboard('{ArrowDown}');
    expect(focusedName()).toBe('Last');
  });
});
