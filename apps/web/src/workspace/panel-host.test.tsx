import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClientState, type ClientState } from '../state/client-state.js';
import { INITIAL_PRESENTATION } from '../state/presentation-state.js';
import { createStore, readable } from '../state/store.js';
import { clientWith, me, need, renderApp, source, stubSizeObserver } from '../test-utils.js';
import type { PanelEntry } from './panel-registry.js';

const client = clientWith({ me: me(), sources: [source('a')] });

const inspector = (content: PanelEntry['content'] = () => <p>Inspector body</p>, extra: Partial<PanelEntry> = {}): PanelEntry => ({ id: 'inspector', title: 'Inspector', placement: { kind: 'dock' }, content, ...extra });

let stub: ReturnType<typeof stubSizeObserver> | undefined;
afterEach(() => stub?.restore());

const column = (container: HTMLElement) => container.querySelector<HTMLElement>('.panel-dock');
const stage = (container: HTMLElement) => need(container.querySelector<HTMLElement>('.workspace-stage'), 'the stage');

describe('the dock column', () => {
  it('is not there when no panel is registered, and the canvas region is the whole stage', async () => {
    const { container } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    expect(column(container)).toBeNull();
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(stage(container)?.children).toHaveLength(1);
    expect(stage(container)?.firstElementChild?.className).toBe('canvas-region');
  });

  it('is beside the canvas region, not in it: the registered panel sits in a column after the canvas region, named by its title', async () => {
    const { container, panels } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    act(() => {
      panels.register(inspector());
    });
    const region = container.querySelector('.canvas-region');
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBe(column(container));
    expect(column(container)?.parentElement).toBe(stage(container));
    expect(column(container)?.previousElementSibling).toBe(region);
    expect(region?.contains(column(container))).toBe(false);
    expect(column(container)?.querySelector('[data-panel="inspector"]')?.textContent).toBe('Inspector body');
  });

  it('is the panel width plus the two 16 px gaps: 352 px for the initial width of 320, and the registration\'s own width when it gives one', async () => {
    const { container, panels } = renderApp('/explore', client);
    const remove = panels.register(inspector());
    await screen.findByText('Local workspace');
    expect(column(container)?.style.width).toBe('352px');
    act(() => remove());
    act(() => {
      panels.register(inspector(undefined, { initialWidth: 400 }));
    });
    expect(column(container)?.style.width).toBe('432px');
  });

  it('is the stored width plus the gaps when a width was stored under the panel\'s ID, and follows a change of it', async () => {
    const state = createClientState();
    const { container, panels } = renderApp('/explore', client, state);
    panels.register(inspector());
    await screen.findByText('Local workspace');
    act(() => state.presentation.setPanelSize('inspector', 400));
    expect(column(container)?.style.width).toBe('432px');
    act(() => state.presentation.setPanelSize('another', 300));
    expect(column(container)?.style.width).toBe('432px');
  });

  it('holds the drawn width to the limits of the window and keeps the stored width, so a larger window gives it back', async () => {
    stub = stubSizeObserver();
    const state = createClientState();
    const { container, panels } = renderApp('/explore', client, state);
    panels.register(inspector());
    await screen.findByText('Local workspace');
    act(() => state.presentation.setPanelSize('inspector', 460));
    act(() => stub?.resize(stage(container), 1440));
    expect(column(container)?.style.width).toBe('492px');
    act(() => stub?.resize(stage(container), 800));
    expect(column(container)?.style.width).toBe('400px');
    act(() => stub?.resize(stage(container), 500));
    expect(column(container)?.style.width).toBe('250px');
    expect(state.presentation.view.getState().panelSizes.get('inspector')).toBe(460);
    act(() => stub?.resize(stage(container), 1440));
    expect(column(container)?.style.width).toBe('492px');
  });

  it('gives the canvas region its width back when the panel is taken out, without touching the other regions', async () => {
    const { container, panels, slots } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    let remove: () => void = () => undefined;
    act(() => {
      slots.register('toggles', () => <p>Toggles</p>);
      remove = panels.register(inspector());
    });
    const toggles = screen.getByText('Toggles');
    expect(toggles.closest('.canvas-region')).not.toBeNull();
    act(() => remove());
    expect(column(container)).toBeNull();
    expect(screen.getByText('Toggles')).toBe(toggles);
  });

  it('shows a notice named with the panel\'s title and PANEL_FAILED when its content throws, and nothing else is affected', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { container, panels, slots } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    act(() => {
      slots.register('toggles', () => <p>Toggles</p>);
      panels.register(
        inspector(() => {
          throw new Error('broken');
        }),
      );
    });
    const notice = screen.getByRole('alert');
    expect(notice.textContent).toBe('Inspector · PANEL_FAILED');
    expect(column(container)?.contains(notice)).toBe(true);
    expect(screen.getByText('Toggles')).toBeTruthy();
    expect(container.querySelector('.canvas-region')).not.toBeNull();
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeTruthy();
    error.mockRestore();
  });

  it('shows a panel registered again after a failure, with its content', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { panels } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    let remove: () => void = () => undefined;
    act(() => {
      remove = panels.register(
        inspector(() => {
          throw new Error('broken');
        }),
      );
    });
    expect(screen.getByRole('alert')).toBeTruthy();
    act(() => remove());
    act(() => {
      panels.register(inspector());
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Inspector body')).toBeTruthy();
    error.mockRestore();
  });
});

function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount((value) => value + 1)}>
      Count {count}
    </button>
  );
}

const toggle = (name: string) => screen.getByRole('button', { name });

describe('collapsing the dock', () => {
  it('has a collapse button named with the title, expanded, on the panel\'s inner edge', async () => {
    const { container, panels } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    act(() => {
      panels.register(inspector());
    });
    const button = toggle('Collapse Inspector');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.className).toBe('panel-toggle');
    expect(button.parentElement?.className).toBe('panel-frame');
    expect(button.previousElementSibling?.className).toBe('panel-handle');
    expect(button.previousElementSibling?.previousElementSibling).toBe(container.querySelector('.panel'));
  });

  it('becomes a rail 40 px wide with the expand button and the title when pressed, and gives the canvas the width less the rail', async () => {
    const { container, panels } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    act(() => {
      panels.register(inspector());
    });
    expect(column(container)?.style.width).toBe('352px');
    fireEvent.click(toggle('Collapse Inspector'));
    expect(column(container)?.style.width).toBe('72px');
    expect(toggle('Expand Inspector').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Collapse Inspector' })).toBeNull();
    expect(container.querySelector('.panel-rail-title')?.textContent).toBe('Inspector');
    expect(container.querySelector('.panel-frame')?.className).toBe('panel-frame panel-frame-collapsed');
  });

  it('keeps the content mounted but hidden, so what is in it is as it was when the panel is expanded', async () => {
    const { container, panels } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    act(() => {
      panels.register(inspector(Counter));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Count 0' }));
    fireEvent.click(toggle('Collapse Inspector'));
    expect(container.querySelector<HTMLElement>('.panel-content')?.hidden).toBe(true);
    expect(screen.queryByRole('button', { name: 'Count 1' })).toBeNull();
    expect(container.querySelector('.panel-content')?.textContent).toBe('Count 1');
    fireEvent.click(toggle('Expand Inspector'));
    expect(container.querySelector<HTMLElement>('.panel-content')?.hidden).toBe(false);
    expect(screen.getByRole('button', { name: 'Count 1' })).toBeTruthy();
  });

  it('expands at the stored width, the initial width when none was stored, and takes the canvas width back by the difference', async () => {
    const state = createClientState();
    const { container, panels } = renderApp('/explore', client, state);
    await screen.findByText('Local workspace');
    act(() => {
      panels.register(inspector());
    });
    fireEvent.click(toggle('Collapse Inspector'));
    fireEvent.click(toggle('Expand Inspector'));
    expect(column(container)?.style.width).toBe('352px');
    fireEvent.click(toggle('Collapse Inspector'));
    expect(column(container)?.style.width).toBe('72px');
    act(() => state.presentation.setPanelSize('inspector', 420));
    expect(column(container)?.style.width).toBe('72px');
    fireEvent.click(toggle('Expand Inspector'));
    expect(column(container)?.style.width).toBe('452px');
  });

  it('expands at the stored width held to the limits of the window at that moment, and keeps the stored width', async () => {
    stub = stubSizeObserver();
    const state = createClientState();
    const { container, panels } = renderApp('/explore', client, state);
    await screen.findByText('Local workspace');
    act(() => {
      panels.register(inspector());
    });
    act(() => stub?.resize(stage(container), 1440));
    act(() => state.presentation.setPanelSize('inspector', 460));
    fireEvent.click(toggle('Collapse Inspector'));
    act(() => stub?.resize(stage(container), 700));
    fireEvent.click(toggle('Expand Inspector'));
    expect(column(container)?.style.width).toBe('350px');
    expect(state.presentation.view.getState().panelSizes.get('inspector')).toBe(460);
    fireEvent.click(toggle('Collapse Inspector'));
    act(() => stub?.resize(stage(container), 1440));
    fireEvent.click(toggle('Expand Inspector'));
    expect(column(container)?.style.width).toBe('492px');
  });

  it('moves the focus to the expand button when the collapse button had it, and back, and leaves it alone otherwise', async () => {
    const { panels } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    act(() => {
      panels.register(inspector());
    });
    const collapse = toggle('Collapse Inspector');
    collapse.focus();
    fireEvent.click(collapse);
    expect(document.activeElement).toBe(toggle('Expand Inspector'));
    fireEvent.click(toggle('Expand Inspector'));
    expect(document.activeElement).toBe(toggle('Collapse Inspector'));
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    fireEvent.click(toggle('Collapse Inspector'));
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(toggle('Expand Inspector'));
    expect(document.activeElement).toBe(document.body);
  });

  it('is operated with Enter and with Space, reached with Tab, and neither key does anything else', async () => {
    const { panels } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    act(() => {
      panels.register(inspector());
    });
    const user = userEvent.setup();
    for (let step = 0; step < 30 && document.activeElement !== toggle('Collapse Inspector'); step += 1) await user.tab();
    expect(document.activeElement).toBe(toggle('Collapse Inspector'));
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(toggle('Expand Inspector'));
    await user.keyboard(' ');
    expect(document.activeElement).toBe(toggle('Collapse Inspector'));
    await user.keyboard('x');
    expect(toggle('Collapse Inspector').getAttribute('aria-expanded')).toBe('true');
  });

  it('clears the collapsed state when the panel is taken out, so a panel registered again with the ID is expanded, and keeps its size', async () => {
    const state = createClientState();
    const { container, panels } = renderApp('/explore', client, state);
    await screen.findByText('Local workspace');
    let remove: () => void = () => undefined;
    act(() => {
      remove = panels.register(inspector());
      state.presentation.setPanelSize('inspector', 400);
    });
    fireEvent.click(toggle('Collapse Inspector'));
    act(() => remove());
    act(() => {
      panels.register(inspector());
    });
    expect(toggle('Collapse Inspector').getAttribute('aria-expanded')).toBe('true');
    expect(column(container)?.style.width).toBe('432px');
  });

  it('removes the collapsed entry itself when the panel is taken out, keeps the size, and leaves a newer registration\'s state when an old remover is called', async () => {
    const state = createClientState();
    const { panels } = renderApp('/explore', client, state);
    await screen.findByText('Local workspace');
    let removeFirst: () => void = () => undefined;
    act(() => {
      removeFirst = panels.register(inspector());
      state.presentation.setPanelSize('inspector', 400);
    });
    fireEvent.click(toggle('Collapse Inspector'));
    expect(state.presentation.view.getState().collapsedPanels.size).toBe(1);
    act(() => removeFirst());
    expect(state.presentation.view.getState().collapsedPanels.size).toBe(0);
    expect(state.presentation.view.getState().panelSizes.get('inspector')).toBe(400);
    act(() => {
      panels.register(inspector());
    });
    fireEvent.click(toggle('Collapse Inspector'));
    act(() => removeFirst());
    expect(state.presentation.view.getState().collapsedPanels.size).toBe(1);
    expect(toggle('Expand Inspector')).toBeTruthy();
  });

  it('keeps the collapsed state and the size when another source is bound', async () => {
    const state = createClientState();
    const { container, panels } = renderApp('/explore', client, state);
    await screen.findByText('Local workspace');
    act(() => {
      panels.register(inspector());
      state.presentation.setPanelSize('inspector', 400);
    });
    fireEvent.click(toggle('Collapse Inspector'));
    act(() => state.bindSource('source-b'));
    expect(toggle('Expand Inspector')).toBeTruthy();
    fireEvent.click(toggle('Expand Inspector'));
    expect(column(container)?.style.width).toBe('432px');
  });

  it('collapses a panel that failed, with the notice kept in its hidden content', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { panels } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    act(() => {
      panels.register(
        inspector(() => {
          throw new Error('broken');
        }),
      );
    });
    fireEvent.click(toggle('Collapse Inspector'));
    expect(toggle('Expand Inspector')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(toggle('Expand Inspector'));
    expect(screen.getByRole('alert').textContent).toBe('Inspector · PANEL_FAILED');
    error.mockRestore();
  });
});

describe('a stored size that is not a size', () => {
  it.each([Number.NaN, Infinity, 0, -40])('is ignored when %s is found, and the initial width is used', async (stored) => {
    const real = createClientState();
    const presentation = createStore({ ...INITIAL_PRESENTATION, panelSizes: new Map([['inspector', stored]]) });
    const state: ClientState = { ...real, presentation: { ...real.presentation, view: readable(presentation) } };
    const { container, panels } = renderApp('/explore', client, state);
    await screen.findByText('Local workspace');
    act(() => {
      panels.register(inspector());
    });
    expect(column(container)?.style.width).toBe('352px');
  });
});

const floating = (id: string, side: 'left' | 'right', top = 64, extra: Partial<PanelEntry> = {}): PanelEntry => ({ id, title: id, placement: { kind: 'floating', side, top }, content: () => <p>{id} body</p>, ...extra });
const box = (container: HTMLElement, id: string) => need(container.querySelector<HTMLElement>(`[data-panel="${id}"]`)?.closest<HTMLElement>('.floating-panel'), `the floating panel ${id}`);
const layer = (container: HTMLElement) => need(container.querySelector<HTMLElement>('.panel-layer'), 'the panel layer');

describe('floating panels', () => {
  it('are not there when none is registered', async () => {
    const { container } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    expect(container.querySelector('.panel-layer')).toBeNull();
  });

  it('are over the canvas, after its other regions so above them, at the top offset and 16 px from the side, at 320 px when no width was given', async () => {
    const { container, panels, slots } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    act(() => {
      slots.register('zoom-controls', () => <p>Zoom</p>);
      panels.register(floating('legend', 'right', 64));
    });
    const region = need(container.querySelector<HTMLElement>('.canvas-region'), 'the canvas region');
    expect(layer(container).parentElement).toBe(region);
    expect(layer(container).previousElementSibling?.className).toBe('region region-zoom-controls');
    expect(box(container, 'legend').style.top).toBe('64px');
    expect(box(container, 'legend').style.right).toBe('16px');
    expect(box(container, 'legend').style.width).toBe('320px');
    expect(screen.getByRole('complementary', { name: 'legend' })).toBe(box(container, 'legend'));
  });

  it('sit the distance from the side that their placement gives, and 16 px when it gives none', async () => {
    const { container, panels } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    act(() => {
      panels.register({ id: 'inset', title: 'inset', placement: { kind: 'floating', side: 'left', top: 64, inset: 72 }, content: () => <p>inset body</p> });
      panels.register(floating('plain', 'left', 64));
    });
    expect(box(container, 'inset').style.left).toBe('72px');
    expect(box(container, 'plain').style.left).toBe('16px');
  });

  it('are drawn at the width of their registration within the limits, and sit in the canvas, left of an open dock', async () => {
    stub = stubSizeObserver();
    const { container, panels } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    act(() => {
      panels.register(inspector());
      panels.register(floating('wide', 'right', 64, { initialWidth: 400 }));
      panels.register(floating('huge', 'left', 64, { initialWidth: 900 }));
    });
    act(() => stub?.resize(layer(container), 900, 700));
    expect(box(container, 'wide').style.width).toBe('400px');
    expect(box(container, 'huge').style.width).toBe('480px');
    expect(column(container)?.contains(box(container, 'wide'))).toBe(false);
    expect(container.querySelector('.canvas-region')?.contains(box(container, 'wide'))).toBe(true);
  });

  it('draw the stored width, held to the limits of the canvas, with the width kept under the panel\'s ID', async () => {
    stub = stubSizeObserver();
    const state = createClientState();
    const { container, panels } = renderApp('/explore', client, state);
    await screen.findByText('Local workspace');
    act(() => {
      panels.register(floating('legend', 'right'));
    });
    act(() => stub?.resize(layer(container), 1000, 700));
    act(() => state.presentation.setPanelSize('legend', 450));
    expect(box(container, 'legend').style.width).toBe('450px');
    act(() => stub?.resize(layer(container), 400, 700));
    expect(box(container, 'legend').style.width).toBe('368px');
    expect(state.presentation.view.getState().panelSizes.get('legend')).toBe(450);
  });

  it('keep a panel with an inset inside a narrow canvas: the width limit counts the inset and the gap on the other side', async () => {
    stub = stubSizeObserver();
    const { container, panels } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    act(() => {
      panels.register({ id: 'inset', title: 'inset', placement: { kind: 'floating', side: 'left', top: 64, inset: 72 }, initialWidth: 400, content: () => <p>inset body</p> });
    });
    act(() => stub?.resize(layer(container), 1000, 700));
    expect(box(container, 'inset').style.width).toBe('400px');
    act(() => stub?.resize(layer(container), 400, 700));
    expect(box(container, 'inset').style.width).toBe('312px');
    expect(box(container, 'inset').style.left).toBe('72px');
  });

  it.each([
    [273, '241px'],
    [272, '240px'],
    [271, '239px'],
    [250, '218px'],
  ])('let the maximum win in a %i px canvas: %s', async (canvasWidth, width) => {
    stub = stubSizeObserver();
    const state = createClientState();
    const { container, panels } = renderApp('/explore', client, state);
    await screen.findByText('Local workspace');
    act(() => {
      panels.register(floating('legend', 'right'));
    });
    act(() => stub?.resize(layer(container), canvasWidth, 700));
    act(() => state.presentation.setPanelSize('legend', 450));
    expect(box(container, 'legend').style.width).toBe(width);
  });

  it('limit the height to the canvas less the offset and 16 px, and let the offset yield so that the collapsed bar fits exactly, 16 px from the bottom', async () => {
    stub = stubSizeObserver();
    const { container, panels } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    act(() => {
      panels.register(floating('legend', 'right', 64));
    });
    act(() => stub?.resize(layer(container), 900, 500));
    expect(box(container, 'legend').style.top).toBe('64px');
    expect(box(container, 'legend').style.maxHeight).toBe('420px');
    act(() => stub?.resize(layer(container), 900, 100));
    expect(box(container, 'legend').style.top).toBe('44px');
    expect(box(container, 'legend').style.maxHeight).toBe('40px');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse legend' }));
    const frame = need(box(container, 'legend').querySelector<HTMLElement>('.panel-frame'), 'the frame');
    expect(frame.style.height).toBe('40px');
    expect(Number.parseInt(box(container, 'legend').style.top, 10) + Number.parseInt(frame.style.height, 10) + 16).toBe(100);
  });

  it('collapse to a bar 40 px high that is as wide as the panel, holding the expand button and the title, and expand again with the content as it was', async () => {
    const { container, panels } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    act(() => {
      panels.register(floating('legend', 'right', 64, { content: Counter }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Count 0' }));
    fireEvent.click(toggle('Collapse legend'));
    const frame = need(box(container, 'legend').querySelector<HTMLElement>('.panel-frame'), 'the frame');
    expect(frame.className).toBe('panel-frame panel-frame-collapsed panel-frame-bar');
    expect(frame.style.height).toBe('40px');
    expect(box(container, 'legend').style.width).toBe('320px');
    expect(container.querySelector('.panel-bar-title')?.textContent).toBe('legend');
    expect(toggle('Expand legend').getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).not.toBe(toggle('Expand legend'));
    fireEvent.click(toggle('Expand legend'));
    expect(screen.getByRole('button', { name: 'Count 1' })).toBeTruthy();
  });

  it('move the focus between the buttons as the dock does', async () => {
    const { panels } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    act(() => {
      panels.register(floating('legend', 'right'));
    });
    toggle('Collapse legend').focus();
    fireEvent.click(toggle('Collapse legend'));
    expect(document.activeElement).toBe(toggle('Expand legend'));
    fireEvent.click(toggle('Expand legend'));
    expect(document.activeElement).toBe(toggle('Collapse legend'));
  });

  it('keep the collapsed state apart from the dock\'s and open expanded when registered again', async () => {
    const { container, panels } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    let remove: () => void = () => undefined;
    act(() => {
      panels.register(inspector());
      remove = panels.register(floating('legend', 'right'));
    });
    fireEvent.click(toggle('Collapse legend'));
    expect(toggle('Collapse Inspector')).toBeTruthy();
    expect(column(container)?.style.width).toBe('352px');
    act(() => remove());
    act(() => {
      panels.register(floating('legend', 'right'));
    });
    expect(toggle('Collapse legend').getAttribute('aria-expanded')).toBe('true');
  });

  it('are each at their own anchor, the one registered later above in the order, and refuse an ID twice', async () => {
    const { container, panels } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    act(() => {
      panels.register(floating('first', 'right', 64));
      panels.register(floating('second', 'left', 200));
    });
    const boxes = [...layer(container).querySelectorAll<HTMLElement>(':scope > .floating-panel')];
    expect(boxes.map((element) => element.getAttribute('aria-label'))).toEqual(['first', 'second']);
    expect([boxes[0]?.style.right, boxes[0]?.style.top]).toEqual(['16px', '64px']);
    expect([boxes[1]?.style.left, boxes[1]?.style.top]).toEqual(['16px', '200px']);
    expect(() => panels.register(floating('first', 'left'))).toThrow('PANEL_TAKEN');
  });

  it('show a notice named with the title when their content throws, without touching the other floating panels or the dock', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { panels } = renderApp('/explore', client);
    await screen.findByText('Local workspace');
    act(() => {
      panels.register(inspector());
      panels.register(floating('broken', 'right', 64, { content: () => {
        throw new Error('broken');
      } }));
      panels.register(floating('fine', 'left'));
    });
    expect(screen.getByRole('alert').textContent).toBe('broken · PANEL_FAILED');
    expect(screen.getByText('fine body')).toBeTruthy();
    expect(screen.getByText('Inspector body')).toBeTruthy();
    error.mockRestore();
  });
});

describe('a floating panel that takes a share of the window', () => {
  const setWindow = (width: number): void => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    act(() => void window.dispatchEvent(new Event('resize')));
  };
  const original = window.innerWidth;
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: original });
  });
  const shared = (id: string, extra: Partial<PanelEntry> = {}): PanelEntry => floating(id, 'right', 64, { widestShareOfWindow: 0.6, ...extra });

  async function open(windowWidth: number, canvasWidth: number, entries: readonly PanelEntry[]) {
    stub = stubSizeObserver();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: windowWidth });
    const state = createClientState();
    const { container, panels } = renderApp('/explore', client, state);
    await screen.findByText('Local workspace');
    act(() => {
      for (const entry of entries) panels.register(entry);
    });
    act(() => stub?.resize(layer(container), canvasWidth, 700));
    return { container, state };
  }

  it('is drawn at 60% of the window, not of the canvas, when a larger width is stored: 864 px at 1440 and 768 px at 1280', async () => {
    const { container, state } = await open(1440, 1384, [shared('assistant')]);
    act(() => state.presentation.setPanelSize('assistant', 2000));
    expect(box(container, 'assistant').style.width).toBe('864px');
    expect(box(container, 'assistant').style.right).toBe('16px');
    setWindow(1280);
    act(() => stub?.resize(layer(container), 1224, 700));
    expect(box(container, 'assistant').style.width).toBe('768px');
  });

  it('keeps a floating panel without a share at 480 px in the same window', async () => {
    const { container, state } = await open(1440, 1384, [floating('legend', 'right')]);
    act(() => state.presentation.setPanelSize('legend', 2000));
    expect(box(container, 'legend').style.width).toBe('480px');
  });

  it('follows a window made narrower and draws the width the person set again when it is made wide, never rewriting the stored width', async () => {
    const { container, state } = await open(1440, 1384, [shared('assistant')]);
    act(() => state.presentation.setPanelSize('assistant', 800));
    expect(box(container, 'assistant').style.width).toBe('800px');
    setWindow(1000);
    act(() => stub?.resize(layer(container), 944, 700));
    expect(box(container, 'assistant').style.width).toBe('600px');
    expect(state.presentation.view.getState().panelSizes.get('assistant')).toBe(800);
    setWindow(1440);
    act(() => stub?.resize(layer(container), 1384, 700));
    expect(box(container, 'assistant').style.width).toBe('800px');
  });

  it('is held to the space the canvas has left, and to 234 px in a 390 px window', async () => {
    const { container, state } = await open(1440, 400, [shared('assistant')]);
    act(() => state.presentation.setPanelSize('assistant', 2000));
    expect(box(container, 'assistant').style.width).toBe('368px');
    setWindow(390);
    act(() => stub?.resize(layer(container), 334, 700));
    expect(box(container, 'assistant').style.width).toBe('234px');
  });

  it('hangs a panel that names it beside it: the gap, the drawn width of that panel and the gap, following the width and the window', async () => {
    const side: PanelEntry = { id: 'inspector', title: 'inspector', placement: { kind: 'floating', side: 'right', top: 64, beside: 'assistant' }, content: () => <p>inspector body</p> };
    const { container, state } = await open(1440, 1384, [shared('assistant'), side]);
    expect(box(container, 'inspector').style.right).toBe('352px');
    act(() => state.presentation.setPanelSize('assistant', 2000));
    expect(box(container, 'inspector').style.right).toBe('896px');
    setWindow(1000);
    act(() => stub?.resize(layer(container), 944, 700));
    expect(box(container, 'inspector').style.right).toBe('632px');
  });

  it('keeps the usual gap for a panel that names one that is not registered', async () => {
    const side: PanelEntry = { id: 'inspector', title: 'inspector', placement: { kind: 'floating', side: 'right', top: 64, beside: 'assistant' }, content: () => <p>inspector body</p> };
    const { container } = await open(1440, 1384, [side]);
    expect(box(container, 'inspector').style.right).toBe('16px');
  });

  it('has a resize handle that reports the 60% limit and goes to it with End and back to the least with Home', async () => {
    const { container, state } = await open(1440, 1384, [shared('assistant')]);
    const handle = screen.getByRole('separator', { name: 'Resize assistant' });
    expect(handle.getAttribute('aria-valuemax')).toBe('864');
    fireEvent.keyDown(handle, { key: 'End' });
    expect(state.presentation.view.getState().panelSizes.get('assistant')).toBe(864);
    expect(box(container, 'assistant').style.width).toBe('864px');
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(box(container, 'assistant').style.width).toBe('240px');
  });
});
