import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCanvasCommands, type CanvasCommands } from '../canvas/canvas-commands.js';
import { RENDERER_UNAVAILABLE } from '../canvas/graph-canvas.js';
import { createClientState } from '../state/client-state.js';
import { item, load, nodeKey, onCanvas, show, withBuiltIns } from './context-menu-kit.js';
import { stateOf, type MenuContext } from './menu-registry.js';
import { LayoutList } from './layout-list.js';
import { PHYSICS_MAX_ENTITIES } from '../canvas/layout-constants.js';
import { ClientStateProvider } from '../state/context.js';

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
const forceRow = (): HTMLElement => screen.getByRole('menuitemradio', { name: 'Force' });

describe('the Layout item of the canvas menu', () => {
  it('is a row with a chevron that opens, beside it, a list with the four layouts and the Physics switch, Force marked, on a press, and not on a disabled one', async () => {
    const { rightClick } = open();
    rightClick(onCanvas(10, 10));
    expect(layoutRow().getAttribute('aria-haspopup')).toBe('menu');
    expect(screen.queryByRole('menuitemradio', { name: 'Force' })).toBeNull();
    await userEvent.setup().click(layoutRow());
    expect(screen.getAllByRole('menuitemradio', { name: 'Force' })).toHaveLength(1);
    expect(forceRow().closest('.context-submenu')).not.toBeNull();
  });

  it('holds the row Force in a menu named Layout of its own, beside the menu named Canvas that owns its row', async () => {
    const { rightClick } = open();
    rightClick(onCanvas(10, 10));
    await userEvent.setup().click(layoutRow());
    const named = screen.getByRole('menu', { name: 'Layout' });
    expect(within(named).getByRole('menuitemradio', { name: 'Force' })).toBe(forceRow());
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
    expect(screen.queryByRole('menuitemradio', { name: 'Force' })).toBeNull();
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
    for (let step = 0; step < 5; step += 1) await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(layoutRow());
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(forceRow());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menuitemradio', { name: 'Force' })).toBeNull();
    expect(screen.getByRole('menu')).not.toBeNull();
    expect(document.activeElement).toBe(layoutRow());
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{ArrowLeft}');
    expect(screen.queryByRole('menuitemradio', { name: 'Force' })).toBeNull();
    expect(document.activeElement).toBe(layoutRow());
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(forceRow());
    await user.keyboard('{Enter}');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(outside);
  });
});

describe('the layout control', () => {
  it('names the layout in its label, and choosing another changes the label', async () => {
    const { state } = open();
    const user = userEvent.setup();
    expect(screen.getByRole('button', { name: 'Layout: Force' }).textContent).toBe('Force ▾');
    await user.click(screen.getByRole('button', { name: 'Layout: Force' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Grid' }));
    expect(state.presentation.view.getState().layout).toBe('grid');
    expect(screen.getByRole('button', { name: 'Layout: Grid' }).textContent).toBe('Grid ▾');
  });

  it('is disabled when nothing is loaded', () => {
    const state = createClientState();
    load(state, []);
    show(state);
    expect(screen.getByRole('button', { name: 'Layout: Force' }).hasAttribute('disabled')).toBe(true);
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
  const commands: CanvasCommands = { fit: () => undefined, zoomBy: () => undefined, layout: () => undefined, centerOn: () => undefined, anchorOf: () => undefined, viewport: () => ({ zoom: 1, x: 0, y: 0 }) };

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
    vi.spyOn(state.presentation, 'applyLayout').mockImplementation(() => {
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
  const inList = (state: ReturnType<typeof createClientState>, props: { readonly disabled: boolean; readonly run?: () => void; readonly done?: () => void }) => (
    <ClientStateProvider state={state}>
      <LayoutList disabled={props.disabled} run={props.run ?? (() => undefined)} done={props.done ?? (() => undefined)} />
    </ClientStateProvider>
  );

  it('shows Force, Hierarchical, Radial and Grid with the current one marked, and Force is the layout in a new session', () => {
    const state = createClientState();
    render(inList(state, { disabled: false }));
    const rows = screen.getAllByRole('menuitemradio');
    expect(rows.map((row) => row.textContent)).toEqual(['Force', 'Hierarchical', 'Radial', 'Grid']);
    expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false']);
  });

  it('keeps the choice in the presentation state, runs the layout and closes, and does nothing and says it is disabled when it is disabled', async () => {
    const state = createClientState();
    const run = vi.fn();
    const done = vi.fn();
    const { rerender } = render(inList(state, { disabled: false, run, done }));
    const user = userEvent.setup();
    await user.click(screen.getByRole('menuitemradio', { name: 'Grid' }));
    expect(state.presentation.view.getState().layout).toBe('grid');
    expect(run).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
    rerender(inList(state, { disabled: true, run, done }));
    expect(screen.getByRole('menuitemradio', { name: 'Radial' }).getAttribute('aria-disabled')).toBe('true');
    await user.click(screen.getByRole('menuitemradio', { name: 'Radial' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: /Physics/ }));
    expect(state.presentation.view.getState().layout).toBe('grid');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('shows the direction rows only under Hierarchical, and runs the layout again with the direction chosen', async () => {
    const state = createClientState();
    const run = vi.fn();
    render(inList(state, { disabled: false, run }));
    expect(screen.queryByRole('menuitemradio', { name: 'Left to right' })).toBeNull();
    act(() => state.presentation.setLayout('hierarchical'));
    expect(screen.getAllByRole('menuitemradio').map((row) => row.textContent)).toEqual(['Force', 'Hierarchical', 'Radial', 'Grid', 'Top to bottom', 'Left to right']);
    expect(screen.getByRole('menuitemradio', { name: 'Top to bottom' }).getAttribute('aria-checked')).toBe('true');
    await userEvent.setup().click(screen.getByRole('menuitemradio', { name: 'Left to right' }));
    expect(state.presentation.view.getState().layoutDirection).toBe('right');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('switches physics on and off under Force, and under another layout disables the row with its line and changes nothing', async () => {
    const state = createClientState();
    render(inList(state, { disabled: false }));
    const user = userEvent.setup();
    const row = () => screen.getByRole('menuitemcheckbox', { name: /Physics/ });
    expect(row().getAttribute('aria-checked')).toBe('false');
    await user.click(row());
    expect(state.presentation.view.getState().physics).toBe(true);
    await user.click(row());
    expect(state.presentation.view.getState().physics).toBe(false);
    act(() => state.presentation.setLayout('grid'));
    expect(row().getAttribute('aria-disabled')).toBe('true');
    expect(row().textContent).toContain('Physics works with Force');
    await user.click(row());
    expect(state.presentation.view.getState().physics).toBe(false);
  });

  it('disables the Physics row with its line above the cap, and leaves the setting as it was', () => {
    const state = createClientState();
    load(state, Array.from({ length: PHYSICS_MAX_ENTITIES + 1 }, (_unused, index) => `n${index}`));
    state.presentation.setPhysics(true);
    render(inList(state, { disabled: false }));
    const row = screen.getByRole('menuitemcheckbox', { name: /Physics/ });
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.textContent).toContain(`Physics is off above ${PHYSICS_MAX_ENTITIES} entities`);
    expect(state.presentation.view.getState().physics).toBe(true);
  });

  it('moves the focus with the arrow keys, Home and End over every row, wrapping at the ends', async () => {
    render(inList(createClientState(), { disabled: false }));
    const rows = [...document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
    act(() => rows[0]?.focus());
    const user = userEvent.setup();
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(rows[rows.length - 1]);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rows[0]);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(rows[rows.length - 1]);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(rows[0]);
  });
});
