import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCanvasCommands, type CanvasCommands } from '../canvas/canvas-commands.js';
import { RENDERER_UNAVAILABLE } from '../canvas/graph-canvas.js';
import { createClientState } from '../state/client-state.js';
import { item, load, nodeKey, onCanvas, show, withBuiltIns } from './context-menu-kit.js';
import { stateOf, type MenuContext } from './menu-registry.js';
import { LayoutList } from './layout-list.js';

function available(commands: CanvasCommands | undefined): CanvasCommands {
  if (commands === undefined) throw new Error('the canvas commands are not available');
  return commands;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ids = Array.from({ length: 12 }, (_unused, index) => `n${index}`);

function Capture({ into }: { readonly into: { current: CanvasCommands | undefined } }) {
  into.current = useCanvasCommands();
  return null;
}

function open(options: { readonly pins?: readonly string[] } = {}) {
  const state = createClientState();
  load(state, ids);
  if (options.pins !== undefined) state.replacePins(options.pins.map(nodeKey));
  const commands: { current: CanvasCommands | undefined } = { current: undefined };
  const shown = show(state, {}, undefined, <Capture into={commands} />);
  return { state, commands, ...shown };
}

const positionsOf = (state: ReturnType<typeof createClientState>): Map<string, { x: number; y: number }> => new Map(state.presentation.view.getState().positions);
const layoutRow = (): HTMLElement => item('Layout');
const forceRow = (): HTMLElement => screen.getByRole('menuitem', { name: 'Force' });

describe('the Layout item of the canvas menu', () => {
  it('is a row with a chevron that opens, beside it, a list with one row, "Force", on a press, and not on a disabled one', async () => {
    const { rightClick } = open();
    rightClick(onCanvas(10, 10));
    expect(layoutRow().getAttribute('aria-haspopup')).toBe('menu');
    expect(screen.queryByRole('menuitem', { name: 'Force' })).toBeNull();
    await userEvent.setup().click(layoutRow());
    expect(screen.getAllByRole('menuitem', { name: 'Force' })).toHaveLength(1);
    expect(forceRow().closest('.context-submenu')).not.toBeNull();
  });

  it('holds the row Force in a menu named Layout of its own, beside the menu named Canvas that owns its row', async () => {
    const { rightClick } = open();
    rightClick(onCanvas(10, 10));
    await userEvent.setup().click(layoutRow());
    const named = screen.getByRole('menu', { name: 'Layout' });
    expect(within(named).getByRole('menuitem', { name: 'Force' })).toBe(forceRow());
    expect(screen.getByRole('menu', { name: 'Canvas' })).not.toBe(named);
    expect(layoutRow().getAttribute('aria-expanded')).toBe('true');
  });

  it('is disabled and opens nothing when nothing is loaded', async () => {
    const state = createClientState();
    load(state, []);
    const shown = show(state);
    shown.rightClick(onCanvas(10, 10));
    expect(layoutRow().getAttribute('aria-disabled')).toBe('true');
    await userEvent.setup().click(layoutRow());
    expect(screen.queryByRole('menuitem', { name: 'Force' })).toBeNull();
  });

  it('runs the one layout command when Force is chosen, closes the whole menu and puts every unpinned entity at the position the layout gives it, leaving the pinned ones', async () => {
    const pins = [ids[0] ?? '', ids[1] ?? ''];
    const { state, commands, rightClick } = open({ pins });
    const before = positionsOf(state);
    rightClick(onCanvas(10, 10));
    const spy = vi.spyOn(available(commands.current), 'layout');
    await userEvent.setup().click(layoutRow());
    await userEvent.setup().click(forceRow());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    const after = positionsOf(state);
    for (const pin of pins) expect(after.get(nodeKey(pin)), pin).toEqual(before.get(nodeKey(pin)));
    const moved = ids.filter((id) => !pins.includes(id)).filter((id) => after.get(nodeKey(id))?.x !== before.get(nodeKey(id))?.x || after.get(nodeKey(id))?.y !== before.get(nodeKey(id))?.y);
    expect(moved.length).toBeGreaterThan(0);
  });

  it('leaves everything where it was when every entity is pinned', async () => {
    const { state, rightClick } = open({ pins: ids });
    const before = positionsOf(state);
    rightClick(onCanvas(10, 10));
    await userEvent.setup().click(layoutRow());
    await userEvent.setup().click(forceRow());
    expect(positionsOf(state)).toEqual(before);
  });

  it('opens on ArrowRight with the focus on Force, closes only the list on Escape and ArrowLeft with the focus back on the row, and runs and closes everything on Enter, returning the focus to where it was', async () => {
    const { commands, rightClick } = open();
    const outside = screen.getByRole('button', { name: 'Outside' });
    act(() => outside.focus());
    rightClick(onCanvas(10, 10));
    const user = userEvent.setup();
    const spy = vi.spyOn(available(commands.current), 'layout');
    for (let step = 0; step < 3; step += 1) await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(layoutRow());
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(forceRow());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menuitem', { name: 'Force' })).toBeNull();
    expect(screen.getByRole('menu')).not.toBeNull();
    expect(document.activeElement).toBe(layoutRow());
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{ArrowLeft}');
    expect(screen.queryByRole('menuitem', { name: 'Force' })).toBeNull();
    expect(document.activeElement).toBe(layoutRow());
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(forceRow());
    await user.keyboard('{Enter}');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(outside);
  });
});

describe('the Layout item and the layout control', () => {
  it('run the one command: a spy on it counts a choice made from the menu and a choice made from the control, and nothing else', async () => {
    const { commands, rightClick } = open();
    const spy = vi.spyOn(available(commands.current), 'layout');
    const user = userEvent.setup();
    rightClick(onCanvas(10, 10));
    await user.click(layoutRow());
    await user.click(forceRow());
    expect(spy).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Layout: Force' }));
    await user.click(forceRow());
    expect(spy).toHaveBeenCalledTimes(2);
    expect(commands.current).toBeDefined();
  });
});

describe('the state of the Layout item', () => {
  const layoutItem = () => {
    const found = withBuiltIns().view.getState().get('canvas')?.find((candidate) => candidate.id === 'layout');
    if (found === undefined) throw new Error('no Layout item');
    return found;
  };
  const contextOf = (state: ReturnType<typeof createClientState>, canvas: CanvasCommands | undefined): MenuContext => ({ kind: 'canvas', key: undefined, selection: [], state, canvas });
  const commands: CanvasCommands = { fit: () => undefined, zoomBy: () => undefined, layout: () => undefined, anchorOf: () => undefined };

  it('is enabled when entities are loaded and the canvas commands are there, and disabled when none is loaded or the commands are not available', () => {
    const loaded = createClientState();
    load(loaded, ids);
    const empty = createClientState();
    load(empty, []);
    expect(stateOf(layoutItem(), contextOf(loaded, commands))).toBe('enabled');
    expect(stateOf(layoutItem(), contextOf(empty, commands))).toBe('disabled');
    expect(stateOf(layoutItem(), contextOf(loaded, undefined))).toBe('disabled');
  });
});

describe('a layout that fails', () => {
  it('shows the notice and keeps the graph and the positions when the layout cannot be stored', async () => {
    const { state, rightClick } = open();
    const before = positionsOf(state);
    rightClick(onCanvas(10, 10));
    vi.spyOn(state.presentation, 'setPositions').mockImplementation(() => {
      throw new Error('cannot store');
    });
    const user = userEvent.setup();
    await user.click(layoutRow());
    await user.click(forceRow());
    expect(screen.getByRole('alert').textContent).toBe(RENDERER_UNAVAILABLE);
    expect(positionsOf(state)).toEqual(before);
    expect(state.loadedGraph().entities.value).toBe(ids.length);
  });

  it('keeps the notice on the screen when the drawing of the layout fails once and the drawing of the restored positions succeeds', async () => {
    const { state, factory, rightClick } = open();
    const before = positionsOf(state);
    rightClick(onCanvas(10, 10));
    const renderer = factory.made[0];
    if (renderer === undefined) throw new Error('no renderer');
    vi.spyOn(renderer, 'draw').mockImplementationOnce(() => {
      throw new Error('cannot draw once');
    });
    const user = userEvent.setup();
    await user.click(layoutRow());
    await user.click(forceRow());
    expect(screen.getByRole('alert').textContent).toBe(RENDERER_UNAVAILABLE);
    expect(positionsOf(state)).toEqual(before);
    expect(renderer.scenes.length).toBeGreaterThan(1);
  });

  it('puts the previous positions back and shows the notice when the layout is stored and the drawing of it fails', async () => {
    const { state, factory, rightClick } = open();
    const before = positionsOf(state);
    rightClick(onCanvas(10, 10));
    const renderer = factory.made[0];
    if (renderer === undefined) throw new Error('no renderer');
    vi.spyOn(renderer, 'draw').mockImplementation(() => {
      throw new Error('cannot draw');
    });
    const user = userEvent.setup();
    await user.click(layoutRow());
    await user.click(forceRow());
    expect(screen.getByRole('alert').textContent).toBe(RENDERER_UNAVAILABLE);
    expect(positionsOf(state)).toEqual(before);
    expect(state.loadedGraph().entities.value).toBe(ids.length);
  });
});

describe('the list of layouts on its own', () => {
  it('shows one row, Force, that calls what it was given with the layout, and does nothing and says it is disabled when it is disabled', async () => {
    const chosen = vi.fn();
    const { rerender } = render(<LayoutList disabled={false} onChoose={chosen} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('menuitem', { name: 'Force' }));
    expect(chosen).toHaveBeenCalledWith('force');
    rerender(<LayoutList disabled onChoose={chosen} />);
    expect(screen.getByRole('menuitem', { name: 'Force' }).getAttribute('aria-disabled')).toBe('true');
    await user.click(screen.getByRole('menuitem', { name: 'Force' }));
    expect(chosen).toHaveBeenCalledTimes(1);
  });

  it('keeps the focus on the one row for the arrow keys, Home and End, and does not throw', async () => {
    render(<LayoutList disabled={false} onChoose={() => undefined} />);
    const row = screen.getByRole('menuitem', { name: 'Force' });
    act(() => row.focus());
    const user = userEvent.setup();
    for (const key of ['{ArrowDown}', '{ArrowUp}', '{Home}', '{End}']) {
      await user.keyboard(key);
      expect(document.activeElement).toBe(row);
    }
    expect(within(document.body).getAllByRole('menuitem')).toHaveLength(1);
  });
});

