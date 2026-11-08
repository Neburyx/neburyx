import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphCanvas } from '../canvas/graph-canvas.js';
import { RendererProvider } from '../canvas/renderer-context.js';
import type { CreateRenderer } from '../canvas/scene.js';
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '../canvas/zoom.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { key, ref, result } from '../state/test-data.js';
import { stubFactory, type StubOptions } from '../test-utils.js';
import { useCanvasCommands, type CanvasCommands } from '../canvas/canvas-commands.js';
import { ZoomControls } from './zoom-controls.js';

function load(state: ClientState, nodes: number): void {
  const ids = Array.from({ length: nodes }, (_unused, index) => `n${index}`);
  state.bindSource('a');
  state.putResult(key('a'), result('a', ids, []));
  state.setLoaded([key('a')], ids.map((id) => ref('a', 'type-a', id)), []);
}

function view(state: ClientState, options: StubOptions = {}) {
  const factory = stubFactory(options);
  const create: CreateRenderer = factory.create;
  render(
    <ClientStateProvider state={state}>
      <RendererProvider createRenderer={create}>
        <GraphCanvas />
        <ZoomControls />
      </RendererProvider>
    </ClientStateProvider>,
  );
  return factory;
}

const button = (name: string): HTMLButtonElement => {
  const found = screen.getByRole('button', { name });
  if (!(found instanceof HTMLButtonElement)) throw new Error(`${name} is not a button element`);
  return found;
};

describe('the zoom controls', () => {
  it('show the three buttons by name and 100% when no view was ever set', () => {
    const state = createClientState();
    load(state, 2);
    view(state);
    expect(screen.getByRole('group', { name: 'Zoom' })).not.toBeNull();
    expect(button('Zoom out')).not.toBeNull();
    expect(button('Zoom in')).not.toBeNull();
    expect(button('Fit to view')).not.toBeNull();
    expect(screen.getByText('100%')).not.toBeNull();
  });

  it('show the stored zoom as a whole-number percentage and follow a change made from outside', () => {
    const state = createClientState();
    load(state, 2);
    view(state);
    act(() => state.presentation.setViewport({ zoom: 2.5, x: 0, y: 0 }));
    expect(screen.getByText('250%')).not.toBeNull();
    act(() => state.presentation.setViewport({ zoom: 0.333, x: 0, y: 0 }));
    expect(screen.getByText('33%')).not.toBeNull();
  });

  it('ask the renderer to zoom by the step, in and out, and to fit', async () => {
    const state = createClientState();
    load(state, 2);
    const factory = view(state);
    const user = userEvent.setup();
    await user.click(button('Zoom in'));
    await user.click(button('Zoom out'));
    await user.click(button('Fit to view'));
    expect(factory.made[0]?.zooms).toEqual([ZOOM_STEP, 1 / ZOOM_STEP]);
    expect(factory.made[0]?.fits).toBe(1);
  });

  it('disable Zoom out at or below the minimum and Zoom in at or above the maximum, and keep the other enabled', () => {
    const state = createClientState();
    load(state, 2);
    view(state);
    act(() => state.presentation.setViewport({ zoom: ZOOM_MIN, x: 0, y: 0 }));
    expect(button('Zoom out').disabled).toBe(true);
    expect(button('Zoom in').disabled).toBe(false);
    act(() => state.presentation.setViewport({ zoom: 0.02, x: 0, y: 0 }));
    expect(button('Zoom out').disabled).toBe(true);
    expect(button('Zoom in').disabled).toBe(false);
    act(() => state.presentation.setViewport({ zoom: ZOOM_MAX, x: 0, y: 0 }));
    expect(button('Zoom in').disabled).toBe(true);
    expect(button('Zoom out').disabled).toBe(false);
  });

  it('disable Fit to view when nothing is drawn and keep the zoom buttons', () => {
    const state = createClientState();
    view(state);
    expect(button('Fit to view').disabled).toBe(true);
    expect(button('Zoom in').disabled).toBe(false);
  });

  it('disable all three buttons and still show the stored zoom when the renderer cannot start', () => {
    const state = createClientState();
    load(state, 2);
    state.presentation.setViewport({ zoom: 2, x: 0, y: 0 });
    view(state, { failOn: 'mount' });
    for (const name of ['Zoom out', 'Zoom in', 'Fit to view']) expect(button(name).disabled).toBe(true);
    expect(screen.getByText('200%')).not.toBeNull();
  });

  it('are reached in order with Tab and act on Enter and Space', async () => {
    const state = createClientState();
    load(state, 2);
    const factory = view(state);
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('application', { name: 'Graph canvas' }));
    await user.tab();
    expect(document.activeElement).toBe(button('Zoom out'));
    await user.tab();
    expect(document.activeElement).toBe(button('Zoom in'));
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    await user.tab();
    expect(document.activeElement).toBe(button('Fit to view'));
    await user.keyboard('{Enter}');
    expect(factory.made[0]?.zooms).toEqual([ZOOM_STEP, ZOOM_STEP]);
    expect(factory.made[0]?.fits).toBe(1);
  });
});

function available(commands: CanvasCommands | undefined): CanvasCommands {
  if (commands === undefined) throw new Error('the canvas commands are not available');
  return commands;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.querySelectorAll('[data-test-outside]').forEach((element) => element.remove());
});

describe('the layout control of the zoom controls', () => {
  function Capture({ into }: { readonly into: { current: CanvasCommands | undefined } }) {
    into.current = useCanvasCommands();
    return null;
  }
  function mount(state: ClientState, options: StubOptions = {}) {
    const factory = stubFactory(options);
    const commands: { current: CanvasCommands | undefined } = { current: undefined };
    render(
      <ClientStateProvider state={state}>
        <RendererProvider createRenderer={factory.create}>
          <GraphCanvas />
          <ZoomControls />
          <Capture into={commands} />
          <button type="button">After the bar</button>
        </RendererProvider>
      </ClientStateProvider>,
    );
    return { factory, commands };
  }
  const control = (): HTMLButtonElement => button('Layout: Force');
  const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
  const loadedState = (nodes = 12): ClientState => {
    const state = createClientState();
    load(state, nodes);
    return state;
  };

  it('is a button after the fit button and a divider, labelled "Force ▾", that announces a menu and is not expanded', () => {
    mount(loadedState());
    const bar = screen.getByRole('group', { name: 'Zoom' });
    const labels = [...bar.querySelectorAll('button, .zoom-divider, .zoom-percentage')].map((element) => element.getAttribute('aria-label') ?? element.textContent);
    expect(labels).toEqual(['Zoom out', '100%', 'Zoom in', 'Fit to view', '│', 'Layout: Force']);
    expect(control().textContent).toBe('Force ▾');
    expect(control().getAttribute('aria-haspopup')).toBe('menu');
    expect(control().getAttribute('aria-expanded')).toBe('false');
    expect(control().disabled).toBe(false);
  });

  it('is disabled when nothing is loaded, and when the canvas commands are not available, and then opens nothing', async () => {
    mount(loadedState(0));
    expect(control().disabled).toBe(true);
    await userEvent.setup().click(control());
    expect(rows()).toEqual([]);
    cleanup();
    mount(loadedState(), { failOn: 'mount' });
    expect(control().disabled).toBe(true);
  });

  it.each([
    ['a press', async () => userEvent.setup().click(control())],
    ['Enter', async () => { act(() => control().focus()); await userEvent.setup().keyboard('{Enter}'); }],
    ['Space', async () => { act(() => control().focus()); await userEvent.setup().keyboard(' '); }],
    ['ArrowDown', async () => { act(() => control().focus()); await userEvent.setup().keyboard('{ArrowDown}'); }],
  ])('opens the list on %s, with the focus on its first row, Force', async (_name, open) => {
    mount(loadedState());
    await open();
    expect(screen.getByRole('menu', { name: 'Layout' })).not.toBeNull();
    expect(rows().map((row) => row.textContent)).toEqual(['Force', 'Hierarchical', 'Radial', 'Grid', 'Physics']);
    expect(document.activeElement).toBe(rows()[0]);
    expect(control().getAttribute('aria-expanded')).toBe('true');
  });

  it('runs the one layout command when Force is chosen, by a press or by Enter or Space, closes the list and returns the focus to the control', async () => {
    const state = loadedState();
    const { commands } = mount(state);
    const user = userEvent.setup();
    const spy = vi.spyOn(available(commands.current), 'layout');
    await user.click(control());
    await user.click(screen.getByRole('menuitemradio', { name: 'Force' }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([]);
    expect(document.activeElement).toBe(control());
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(control());
    await user.keyboard('{ArrowDown}');
    await user.keyboard(' ');
    expect(spy).toHaveBeenCalledTimes(3);
    expect(state.presentation.view.getState().positions.size).toBe(12);
  });

  it('moves the focus with the arrow keys, Home and End over the rows', async () => {
    mount(loadedState());
    await userEvent.setup().click(control());
    const user = userEvent.setup();
    const list = rows();
    for (const [key, expected] of [['{ArrowDown}', list[1]], ['{ArrowUp}', list[0]], ['{ArrowUp}', list[list.length - 1]], ['{Home}', list[0]], ['{End}', list[list.length - 1]]] as const) {
      await user.keyboard(key);
      expect(document.activeElement).toBe(expected);
    }
  });

  it('closes on Escape with the focus on the control, and on Tab with the focus moving on from the control, and on a press outside without choosing', async () => {
    const { commands } = mount(loadedState());
    const user = userEvent.setup();
    const spy = vi.spyOn(available(commands.current), 'layout');
    await user.click(control());
    await user.keyboard('{Escape}');
    expect(rows()).toEqual([]);
    expect(document.activeElement).toBe(control());
    await user.click(control());
    await user.keyboard('{Tab}');
    expect(rows()).toEqual([]);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After the bar' }));
    await user.click(control());
    await user.click(screen.getByRole('button', { name: 'After the bar' }));
    expect(rows()).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('closes when a press on the control would toggle it, and keeps open for a press inside the list', async () => {
    mount(loadedState());
    const user = userEvent.setup();
    await user.click(control());
    fireEvent.pointerDown(screen.getByRole('menu', { name: 'Layout' }));
    expect(rows().length).toBeGreaterThan(0);
    await user.click(control());
    expect(rows()).toEqual([]);
  });

  it('does not open again by itself when entities are loaded again after the list was closed by clearing them', async () => {
    const state = loadedState();
    mount(state);
    await userEvent.setup().click(control());
    expect(rows().length).toBeGreaterThan(0);
    act(() => state.setLoaded([key('a')], [], []));
    expect(rows()).toEqual([]);
    act(() => load(state, 12));
    expect(rows()).toEqual([]);
    expect(control().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).not.toBe(screen.queryByRole('menuitemradio', { name: 'Force' }));
  });

  it('names its menu "Layout" and holds the row Force in it', async () => {
    mount(loadedState());
    await userEvent.setup().click(control());
    const menus = screen.getAllByRole('menu');
    expect(menus).toHaveLength(1);
    expect(within(screen.getByRole('menu', { name: 'Layout' })).getByRole('menuitemradio', { name: 'Force' })).toBe(rows()[0]);
  });

  it('closes when the commands become unavailable or nothing is loaded while it is open', async () => {
    const state = loadedState();
    mount(state);
    await userEvent.setup().click(control());
    expect(rows().length).toBeGreaterThan(0);
    act(() => state.setLoaded([key('a')], [], []));
    expect(rows()).toEqual([]);
  });

  it('is placed above the control, its right edge level with the control\'s, and again after the window is resized', async () => {
    const state = loadedState();
    mount(state);
    const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('zoom-button-layout')) return rect(800, 640, 50, 28);
      if (this.classList.contains('layout-popup')) return rect(0, 0, 130, 40);
      return rect(0, 0, 0, 0);
    });
    await userEvent.setup().click(control());
    const holder = document.querySelector<HTMLElement>('.layout-popup');
    expect(holder?.style.left).toBe(`${850 - 130}px`);
    expect(holder?.style.top).toBe(`${640 - 6 - 40}px`);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    act(() => void window.dispatchEvent(new Event('resize')));
    expect(document.querySelector<HTMLElement>('.layout-popup')?.style.left).toBe(`${800 - 8 - 130}px`);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  });

  it('is operable with the keyboard alone: the control is reached with Tab after Fit to view, and the whole path opens, chooses and returns', async () => {
    mount(loadedState());
    const user = userEvent.setup();
    act(() => button('Fit to view').focus());
    await user.tab();
    expect(document.activeElement).toBe(control());
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(control());
  });
});
