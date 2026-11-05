import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClientState, type ClientState } from '../state/client-state.js';
import { clientWith, me, need, renderApp, source, stubSizeObserver } from '../test-utils.js';
import type { PanelEntry, PanelRegistry } from './panel-registry.js';

const client = clientWith({ me: me(), sources: [source('a')] });

const inspector: PanelEntry = { id: 'inspector', title: 'Inspector', placement: { kind: 'dock' }, content: () => <p>Inspector body</p> };

let stub: ReturnType<typeof stubSizeObserver> | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => void vi.runOnlyPendingTimers());
  stub?.restore();
  stub = undefined;
  vi.useRealTimers();
});

const column = (container: HTMLElement) => container.querySelector<HTMLElement>('.panel-dock');
const stage = (container: HTMLElement) => need(container.querySelector<HTMLElement>('.workspace-stage'), 'the stage');
const handle = (_container?: HTMLElement) => screen.getByRole('separator', { name: 'Resize Inspector' });
const frame = () => act(() => void vi.advanceTimersByTime(20));
const sizeOf = (state: ClientState) => state.presentation.view.getState().panelSizes.get('inspector');

function shown(options: { readonly stageWidth?: number; readonly stored?: number } = {}): { readonly container: HTMLElement; readonly state: ClientState; readonly panels: PanelRegistry; readonly remove: () => void } {
  if (options.stageWidth !== undefined) stub = stubSizeObserver();
  const state = createClientState();
  const rendered = renderApp('/explore', client, state);
  let remove: () => void = () => undefined;
  act(() => {
    remove = rendered.panels.register(inspector);
  });
  if (options.stageWidth !== undefined) act(() => stub?.resize(stage(rendered.container), options.stageWidth ?? 0));
  if (options.stored !== undefined) act(() => state.presentation.setPanelSize('inspector', options.stored ?? 0));
  return { container: rendered.container, state, panels: rendered.panels, remove };
}

const press = (target: HTMLElement, clientX: number, init: Record<string, unknown> = {}) => fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX, ...init });
const move = (target: HTMLElement, clientX: number) => fireEvent.pointerMove(target, { pointerId: 1, clientX });
const release = (target: HTMLElement, clientX: number) => fireEvent.pointerUp(target, { pointerId: 1, clientX });

describe('the resize handle', () => {
  it('is on the panel\'s inner edge, before the collapse button, and not there when the panel is collapsed', () => {
    const { container } = shown();
    const edge = handle(container);
    expect(edge.nextElementSibling?.className).toBe('panel-toggle');
    expect(edge.parentElement?.className).toBe('panel-frame');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Inspector' }));
    expect(container.querySelector('.panel-handle')).toBeNull();
  });
});

describe('resizing the dock by dragging', () => {
  it('widens the panel by the distance the pointer moves left and narrows it by the distance it moves right, live, and keeps the width under the panel\'s ID', () => {
    const { container, state } = shown();
    press(handle(container), 1000);
    move(handle(container), 950);
    frame();
    expect(column(container)?.style.width).toBe('402px');
    expect(sizeOf(state)).toBe(370);
    move(handle(container), 1040);
    frame();
    expect(sizeOf(state)).toBe(280);
    expect(column(container)?.style.width).toBe('312px');
    release(handle(container), 1040);
    expect(sizeOf(state)).toBe(280);
  });

  it('updates the store at most once for each frame, however many moves arrive, with the last position', () => {
    const { container, state } = shown();
    const writes = vi.fn();
    state.presentation.view.subscribe(writes);
    press(handle(container), 1000);
    for (const x of [990, 980, 970, 960]) move(handle(container), x);
    expect(writes).not.toHaveBeenCalled();
    frame();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(sizeOf(state)).toBe(360);
    move(handle(container), 900);
    move(handle(container), 890);
    frame();
    expect(writes).toHaveBeenCalledTimes(2);
    expect(sizeOf(state)).toBe(430);
  });

  it('writes the last position, in the frame that was waiting, when the pointer is released before the frame comes, and ends the drag with it', () => {
    const { container, state } = shown();
    press(handle(container), 1000);
    move(handle(container), 960);
    release(handle(container), 960);
    expect(sizeOf(state)).toBeUndefined();
    expect(document.body.classList.contains('panel-resizing')).toBe(true);
    frame();
    expect(sizeOf(state)).toBe(360);
    expect(document.body.classList.contains('panel-resizing')).toBe(false);
    move(handle(container), 900);
    frame();
    expect(sizeOf(state)).toBe(360);
  });

  it('stops at the maximum and at the minimum, follows the pointer when it comes back inside, and holds the maximum to half the workspace less 32', () => {
    const { container, state } = shown({ stageWidth: 1440 });
    press(handle(container), 1000);
    move(handle(container), 0);
    frame();
    expect(sizeOf(state)).toBe(480);
    move(handle(container), 700);
    frame();
    expect(sizeOf(state)).toBe(480);
    move(handle(container), 880);
    frame();
    expect(sizeOf(state)).toBe(440);
    move(handle(container), 2000);
    frame();
    expect(sizeOf(state)).toBe(240);
    move(handle(container), 1100);
    frame();
    expect(sizeOf(state)).toBe(240);
    move(handle(container), 960);
    frame();
    expect(sizeOf(state)).toBe(360);
  });

  it.each([
    [1000, 468],
    [1023, 479],
    [1281, 480],
  ])('holds the maximum to half of a %i px workspace less 32: %i', (stageWidth, maximum) => {
    const { container, state } = shown({ stageWidth });
    press(handle(container), 1000);
    move(handle(container), 0);
    frame();
    expect(sizeOf(state)).toBe(maximum);
  });

  it.each([
    [546, 241, 240],
    [544, 240, 240],
    [540, 238, 238],
  ])('in a %i px workspace lets the maximum win below 240: the range is %i to %i for a drag outwards', (stageWidth, maximum, minimum) => {
    const { container, state } = shown({ stageWidth });
    press(handle(container), 1000);
    move(handle(container), 0);
    frame();
    expect(sizeOf(state)).toBe(maximum);
    move(handle(container), 2000);
    frame();
    expect(sizeOf(state)).toBe(minimum);
  });

  it('draws the stored width at the limit of a narrower window and keeps the stored width for a wider one', () => {
    const { container, state } = shown({ stageWidth: 1440, stored: 460 });
    expect(column(container)?.style.width).toBe('492px');
    act(() => stub?.resize(stage(container), 700));
    expect(column(container)?.style.width).toBe('350px');
    expect(sizeOf(state)).toBe(460);
    act(() => stub?.resize(stage(container), 1440));
    expect(column(container)?.style.width).toBe('492px');
  });

  it('captures the pointer, keeps the text from being selected and shows the drag on the page until it ends', () => {
    const { container } = shown();
    const edge = handle(container);
    const capture = vi.fn();
    edge.setPointerCapture = capture;
    expect(press(edge, 1000)).toBe(false);
    expect(capture).toHaveBeenCalledWith(1);
    expect(document.body.classList.contains('panel-resizing')).toBe(true);
    release(edge, 1000);
    expect(document.body.classList.contains('panel-resizing')).toBe(false);
  });

  it('reports no click on the panel or the canvas for a drag or a press, and changes nothing for a press without movement', () => {
    const { container, state } = shown();
    const clicked = vi.fn();
    document.addEventListener('click', clicked);
    press(handle(container), 1000);
    release(handle(container), 1000);
    fireEvent.click(handle(container));
    press(handle(container), 1000);
    move(handle(container), 900);
    frame();
    release(handle(container), 900);
    fireEvent.click(handle(container));
    document.removeEventListener('click', clicked);
    expect(clicked).not.toHaveBeenCalled();
    expect(sizeOf(state)).toBe(420);
  });

  it('writes nothing for a press and release without movement, and ignores a pointer that is not the main button', () => {
    const { container, state } = shown();
    const writes = vi.fn();
    state.presentation.view.subscribe(writes);
    press(handle(container), 1000);
    release(handle(container), 1000);
    frame();
    press(handle(container), 1000, { button: 2 });
    move(handle(container), 900);
    frame();
    expect(writes).not.toHaveBeenCalled();
    expect(sizeOf(state)).toBeUndefined();
  });

  it('ignores moves when no drag started, and a second press during a drag', () => {
    const { container, state } = shown();
    move(handle(container), 900);
    frame();
    expect(sizeOf(state)).toBeUndefined();
    press(handle(container), 1000);
    press(handle(container), 500);
    move(handle(container), 900);
    frame();
    expect(sizeOf(state)).toBe(420);
  });

  it('is not started by the collapse button', () => {
    const { container, state } = shown();
    const button = screen.getByRole('button', { name: 'Collapse Inspector' });
    fireEvent.pointerDown(button, { button: 0, pointerId: 1, clientX: 1000 });
    fireEvent.pointerMove(button, { pointerId: 1, clientX: 900 });
    frame();
    expect(document.body.classList.contains('panel-resizing')).toBe(false);
    expect(sizeOf(state)).toBeUndefined();
    expect(column(container)?.style.width).toBe('352px');
  });
});

describe('a drag that is interrupted', () => {
  const interruptions: ReadonlyArray<readonly [string, (container: HTMLElement, state: ClientState, panels: PanelRegistry) => void]> = [
    ['the pointer is cancelled', (container) => fireEvent.pointerCancel(handle(container), { pointerId: 1 })],
    ['the capture is lost without a release', (container) => fireEvent.lostPointerCapture(handle(container), { pointerId: 1 })],
    ['the window loses focus', () => void fireEvent.blur(window)],
    ['another source is bound', (_container, state) => state.bindSource('source-b')],
  ];

  it.each(interruptions)('puts the width back where it was at the press, with nothing stored, when %s', (_name, interrupt) => {
    const { container, state, panels } = shown();
    press(handle(container), 1000);
    move(handle(container), 900);
    frame();
    expect(sizeOf(state)).toBe(420);
    act(() => interrupt(container, state, panels));
    expect(sizeOf(state)).toBeUndefined();
    expect(column(container)?.style.width).toBe('352px');
    move(handle(container), 800);
    frame();
    expect(sizeOf(state)).toBeUndefined();
    expect(document.body.classList.contains('panel-resizing')).toBe(false);
  });

  it.each(interruptions)('puts back the width that was stored before the drag when %s', (_name, interrupt) => {
    const { container, state, panels } = shown({ stored: 400 });
    press(handle(container), 1000);
    move(handle(container), 900);
    frame();
    expect(sizeOf(state)).toBe(480);
    act(() => interrupt(container, state, panels));
    expect(sizeOf(state)).toBe(400);
  });

  it.each(interruptions)('writes nothing for a frame that was still queued when %s', (_name, interrupt) => {
    const { container, state, panels } = shown();
    press(handle(container), 1000);
    move(handle(container), 900);
    act(() => interrupt(container, state, panels));
    frame();
    expect(sizeOf(state)).toBeUndefined();
    expect(column(container)?.style.width).toBe('352px');
  });

  it('puts the width back when the panel is taken out, and a frame still queued writes nothing even when the panel is registered again before it', () => {
    const { container, state, panels, remove } = shown({ stored: 400 });
    press(handle(container), 1000);
    move(handle(container), 960);
    frame();
    expect(sizeOf(state)).toBe(440);
    move(handle(container), 900);
    act(() => remove());
    expect(sizeOf(state)).toBe(400);
    act(() => {
      panels.register(inspector);
    });
    frame();
    expect(sizeOf(state)).toBe(400);
    expect(column(container)?.style.width).toBe('432px');
    expect(document.body.classList.contains('panel-resizing')).toBe(false);
  });

  it('puts the width back, with nothing stored, when the panel is collapsed during the drag', () => {
    const { container, state } = shown();
    press(handle(container), 1000);
    move(handle(container), 900);
    frame();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Inspector' }));
    expect(sizeOf(state)).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Inspector' }));
    expect(column(container)?.style.width).toBe('352px');
  });
});

describe('the drag guard on the page', () => {
  it('stays while a drag goes on when another panel is taken out, and goes when the drag ends', () => {
    stub = undefined;
    const state = createClientState();
    const { container, panels } = renderApp('/explore', client, state);
    let removeLegend: () => void = () => undefined;
    act(() => {
      panels.register(inspector);
      removeLegend = panels.register({ id: 'legend', title: 'Legend', placement: { kind: 'floating', side: 'right', top: 64 }, content: () => <p>Legend body</p> });
    });
    press(handle(container), 1000);
    expect(document.body.classList.contains('panel-resizing')).toBe(true);
    act(() => removeLegend());
    expect(document.body.classList.contains('panel-resizing')).toBe(true);
    move(handle(container), 900);
    frame();
    expect(sizeOf(state)).toBe(420);
    release(handle(container), 900);
    expect(document.body.classList.contains('panel-resizing')).toBe(false);
  });
});

describe('the commits of a drag', () => {
  it('writes the store once for a move that a frame committed, and not again when the pointer is released in the same frame', () => {
    const { container, state } = shown();
    const writes = vi.fn();
    state.presentation.view.subscribe(writes);
    press(handle(container), 1000);
    move(handle(container), 960);
    frame();
    expect(writes).toHaveBeenCalledTimes(1);
    release(handle(container), 960);
    frame();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(sizeOf(state)).toBe(360);
  });

  it('writes the final position once when a move is still waiting for its frame at the release, and writes nothing more after it', () => {
    const { container, state } = shown();
    const writes = vi.fn();
    state.presentation.view.subscribe(writes);
    press(handle(container), 1000);
    move(handle(container), 960);
    frame();
    move(handle(container), 900);
    release(handle(container), 900);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(sizeOf(state)).toBe(360);
    frame();
    expect(writes).toHaveBeenCalledTimes(2);
    expect(sizeOf(state)).toBe(420);
    frame();
    expect(writes).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['with no frame committed before the release', false, 360],
    ['with a frame committed before the release', true, 420],
  ])('keeps the last position when the capture is let go after the release, as a browser does: %s', (_name, committedEarlier, width) => {
    const { container, state } = shown();
    press(handle(container), 1000);
    if (committedEarlier) {
      move(handle(container), 960);
      frame();
      expect(sizeOf(state)).toBe(360);
    }
    move(handle(container), committedEarlier ? 900 : 960);
    release(handle(container), committedEarlier ? 900 : 960);
    fireEvent.lostPointerCapture(handle(container), { pointerId: 1 });
    frame();
    expect(sizeOf(state)).toBe(width);
    expect(document.body.classList.contains('panel-resizing')).toBe(false);
  });

  it('still cancels, with the width put back, when the capture is lost before any release', () => {
    const { container, state } = shown();
    press(handle(container), 1000);
    move(handle(container), 960);
    frame();
    move(handle(container), 900);
    fireEvent.lostPointerCapture(handle(container), { pointerId: 1 });
    frame();
    expect(sizeOf(state)).toBeUndefined();
  });

  it.each([
    ['the window loses focus', (_state: ClientState, _panels: PanelRegistry, _remove: () => void) => void fireEvent.blur(window)],
    ['another source is bound', (state: ClientState) => state.bindSource('source-b')],
    ['the panel is taken out', (_state: ClientState, _panels: PanelRegistry, remove: () => void) => remove()],
    ['the pointer is cancelled', () => void fireEvent.pointerCancel(handle(), { pointerId: 1 })],
  ])('writes the last position in the frame that was waiting, and rolls nothing back, when %s after the release and before the frame', (_name, interrupt) => {
    const { container, state, panels, remove } = shown({ stored: 400 });
    press(handle(container), 1000);
    move(handle(container), 960);
    frame();
    expect(sizeOf(state)).toBe(440);
    let sizes = state.presentation.view.getState().panelSizes;
    let writes = 0;
    state.presentation.view.subscribe(() => {
      const now = state.presentation.view.getState().panelSizes;
      if (now !== sizes) writes += 1;
      sizes = now;
    });
    move(handle(container), 900);
    release(handle(container), 900);
    act(() => interrupt(state, panels, remove));
    expect(sizeOf(state)).toBe(440);
    expect(writes).toBe(0);
    expect(document.body.classList.contains('panel-resizing')).toBe(false);
    frame();
    expect(sizeOf(state)).toBe(480);
    expect(writes).toBe(1);
    frame();
    expect(writes).toBe(1);
  });

  it.each([
    ['the window loses focus', (_state: ClientState, _remove: () => void) => void fireEvent.blur(window)],
    ['the panel is taken out', (_state: ClientState, remove: () => void) => remove()],
  ])('writes the last position once when a drag with nothing waiting is released and %s in the same frame', (_name, interrupt) => {
    const { container, state, remove } = shown({ stored: 400 });
    press(handle(container), 1000);
    move(handle(container), 960);
    release(handle(container), 960);
    act(() => interrupt(state, remove));
    frame();
    expect(sizeOf(state)).toBe(440);
  });


  it('writes whole pixels for a pointer that is between pixels', () => {
    const { container, state } = shown();
    press(handle(container), 1000.4);
    move(handle(container), 959.8);
    frame();
    expect(sizeOf(state)).toBe(361);
    expect(Number.isInteger(sizeOf(state))).toBe(true);
  });
});

describe('a key pressed while a drag is going on', () => {
  const key = (container: HTMLElement, name: string, init: Record<string, unknown> = {}) => fireEvent.keyDown(handle(container), { key: name, ...init });
  const watched = (state: ClientState) => {
    let sizes = state.presentation.view.getState().panelSizes;
    const count = { writes: 0 };
    state.presentation.view.subscribe(() => {
      const now = state.presentation.view.getState().panelSizes;
      if (now !== sizes) count.writes += 1;
      sizes = now;
    });
    return count;
  };

  it('waits for the drag: a resize key during a drag changes nothing, is not swallowed, and nothing later undoes it or rolls the drag back', () => {
    const { container, state } = shown({ stored: 400 });
    press(handle(container), 1000);
    move(handle(container), 960);
    expect(key(container, 'Home')).toBe(true);
    frame();
    expect(sizeOf(state)).toBe(440);
    expect(key(container, 'ArrowLeft')).toBe(true);
    release(handle(container), 960);
    expect(sizeOf(state)).toBe(440);
    key(container, 'Home');
    expect(sizeOf(state)).toBe(240);
  });

  it('is ignored between the release and the frame that writes the last position, which then lands once and is not overwritten, and works after that frame from the width drawn', () => {
    const { container, state } = shown({ stored: 400 });
    press(handle(container), 1000);
    move(handle(container), 960);
    frame();
    const count = watched(state);
    move(handle(container), 900);
    release(handle(container), 900);
    expect(key(container, 'Home')).toBe(true);
    expect(count.writes).toBe(0);
    frame();
    expect(sizeOf(state)).toBe(480);
    expect(count.writes).toBe(1);
    expect(key(container, 'ArrowRight')).toBe(false);
    expect(sizeOf(state)).toBe(464);
    expect(count.writes).toBe(2);
  });

  it('is ignored too when the capture was let go after the release and the frame is still to come, so the frame does not overwrite a newer key', () => {
    const { container, state } = shown({ stored: 400 });
    press(handle(container), 1000);
    move(handle(container), 960);
    frame();
    move(handle(container), 900);
    release(handle(container), 900);
    fireEvent.lostPointerCapture(handle(container), { pointerId: 1 });
    key(container, 'Home');
    frame();
    expect(sizeOf(state)).toBe(480);
    key(container, 'Home');
    expect(sizeOf(state)).toBe(240);
    frame();
    expect(sizeOf(state)).toBe(240);
  });

  it('does not lift the drag guard of another panel, and a key on another panel\'s handle waits for the drag: Home on a focused floating handle changes nothing while the dock\'s drag goes on', () => {
    stub = undefined;
    const state = createClientState();
    const { container, panels } = renderApp('/explore', client, state);
    act(() => {
      panels.register(inspector);
      panels.register({ id: 'legend', title: 'Legend', placement: { kind: 'floating', side: 'right', top: 64 }, content: () => <p>Legend body</p> });
    });
    const legendHandle = within(screen.getByRole('complementary', { name: 'Legend' })).getByRole('separator', { name: 'Resize Legend' });
    legendHandle.focus();
    press(handle(container), 1000);
    expect(document.body.classList.contains('panel-resizing')).toBe(true);
    expect(fireEvent.keyDown(legendHandle, { key: 'Home' })).toBe(true);
    expect(document.body.classList.contains('panel-resizing')).toBe(true);
    expect(state.presentation.view.getState().panelSizes.get('legend')).toBeUndefined();
    move(handle(container), 900);
    frame();
    expect(sizeOf(state)).toBe(420);
    release(handle(container), 900);
    expect(document.body.classList.contains('panel-resizing')).toBe(false);
  });

  it('keeps a second drag, on any handle, from starting while one is going on or waiting for its last frame, and lets it start after', () => {
    stub = undefined;
    const state = createClientState();
    const { container, panels } = renderApp('/explore', client, state);
    act(() => {
      panels.register(inspector);
      panels.register({ id: 'legend', title: 'Legend', placement: { kind: 'floating', side: 'right', top: 64 }, content: () => <p>Legend body</p> });
    });
    const legendHandle = within(screen.getByRole('complementary', { name: 'Legend' })).getByRole('separator', { name: 'Resize Legend' });
    press(handle(container), 1000);
    move(handle(container), 960);
    release(handle(container), 960);
    act(() => void fireEvent.blur(window));
    expect(document.body.classList.contains('panel-resizing')).toBe(false);
    fireEvent.pointerDown(legendHandle, { button: 0, pointerId: 2, clientX: 500 });
    fireEvent.pointerMove(legendHandle, { pointerId: 2, clientX: 400 });
    expect(document.body.classList.contains('panel-resizing')).toBe(false);
    frame();
    expect(sizeOf(state)).toBe(360);
    expect(state.presentation.view.getState().panelSizes.get('legend')).toBeUndefined();
    fireEvent.pointerDown(legendHandle, { button: 0, pointerId: 2, clientX: 500 });
    expect(document.body.classList.contains('panel-resizing')).toBe(true);
    fireEvent.pointerUp(legendHandle, { pointerId: 2, clientX: 500 });
    expect(document.body.classList.contains('panel-resizing')).toBe(false);
  });

  it('keeps the guard when one of two overlapping presses is ignored and the first drag is released, never lifting what it does not own', () => {
    stub = undefined;
    const state = createClientState();
    const { container, panels } = renderApp('/explore', client, state);
    act(() => {
      panels.register(inspector);
      panels.register({ id: 'legend', title: 'Legend', placement: { kind: 'floating', side: 'right', top: 64 }, content: () => <p>Legend body</p> });
    });
    const legendHandle = within(screen.getByRole('complementary', { name: 'Legend' })).getByRole('separator', { name: 'Resize Legend' });
    fireEvent.pointerDown(handle(container), { button: 0, pointerId: 1, clientX: 1000 });
    fireEvent.pointerDown(legendHandle, { button: 0, pointerId: 2, clientX: 500 });
    fireEvent.pointerUp(legendHandle, { pointerId: 2, clientX: 500 });
    fireEvent.pointerCancel(legendHandle, { pointerId: 2 });
    fireEvent.lostPointerCapture(legendHandle, { pointerId: 2 });
    expect(document.body.classList.contains('panel-resizing')).toBe(true);
    move(handle(container), 900);
    frame();
    expect(sizeOf(state)).toBe(420);
    release(handle(container), 900);
    expect(document.body.classList.contains('panel-resizing')).toBe(false);
  });

  it('answers only the handle that started the drag: the same pointer ID reaching another handle moves, releases, cancels or loses capture nothing', () => {
    stub = undefined;
    const state = createClientState();
    const { container, panels } = renderApp('/explore', client, state);
    act(() => {
      panels.register(inspector);
      panels.register({ id: 'legend', title: 'Legend', placement: { kind: 'floating', side: 'right', top: 64 }, content: () => <p>Legend body</p> });
    });
    const legendHandle = within(screen.getByRole('complementary', { name: 'Legend' })).getByRole('separator', { name: 'Resize Legend' });
    press(handle(container), 1000);
    fireEvent.pointerMove(legendHandle, { pointerId: 1, clientX: 800 });
    frame();
    expect(sizeOf(state)).toBeUndefined();
    expect(state.presentation.view.getState().panelSizes.get('legend')).toBeUndefined();
    fireEvent.pointerUp(legendHandle, { pointerId: 1, clientX: 800 });
    fireEvent.pointerCancel(legendHandle, { pointerId: 1 });
    fireEvent.lostPointerCapture(legendHandle, { pointerId: 1 });
    expect(document.body.classList.contains('panel-resizing')).toBe(true);
    move(handle(container), 960);
    frame();
    expect(sizeOf(state)).toBe(360);
    release(handle(container), 960);
    expect(document.body.classList.contains('panel-resizing')).toBe(false);
  });

  it('keeps a key from overwriting, or being overwritten by, a last write that is waiting for its frame when the handle was taken out and came back', () => {
    const { container, state } = shown({ stored: 400 });
    press(handle(container), 1000);
    move(handle(container), 960);
    frame();
    expect(sizeOf(state)).toBe(440);
    move(handle(container), 900);
    release(handle(container), 900);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Inspector' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand Inspector' }));
    expect(fireEvent.keyDown(handle(container), { key: 'Home' })).toBe(true);
    press(handle(container), 1000, { pointerId: 5 });
    expect(document.body.classList.contains('panel-resizing')).toBe(false);
    frame();
    expect(sizeOf(state)).toBe(480);
    expect(fireEvent.keyDown(handle(container), { key: 'Home' })).toBe(false);
    expect(sizeOf(state)).toBe(240);
    frame();
    expect(sizeOf(state)).toBe(240);
  });

  it('answers only the pointer that started the drag: another pointer\'s move, release, cancel and capture loss on the same handle change nothing', () => {
    const { container, state } = shown();
    press(handle(container), 1000);
    fireEvent.pointerMove(handle(container), { pointerId: 2, clientX: 800 });
    frame();
    expect(sizeOf(state)).toBeUndefined();
    fireEvent.pointerUp(handle(container), { pointerId: 2, clientX: 800 });
    fireEvent.pointerCancel(handle(container), { pointerId: 2 });
    fireEvent.lostPointerCapture(handle(container), { pointerId: 2 });
    expect(document.body.classList.contains('panel-resizing')).toBe(true);
    move(handle(container), 960);
    frame();
    expect(sizeOf(state)).toBe(360);
    fireEvent.pointerMove(handle(container), { pointerId: 2, clientX: 700 });
    frame();
    expect(sizeOf(state)).toBe(360);
    release(handle(container), 960);
    expect(document.body.classList.contains('panel-resizing')).toBe(false);
  });

  it('never writes a width that is not a size, and does not throw, in a workspace too narrow to hold a panel', () => {
    const { container, state } = shown({ stageWidth: 40 });
    expect(handle(container).getAttribute('aria-valuemax')).toBe('0');
    press(handle(container), 1000);
    move(handle(container), 500);
    expect(() => frame()).not.toThrow();
    release(handle(container), 500);
    expect(() => fireEvent.keyDown(handle(container), { key: 'End' })).not.toThrow();
    expect(sizeOf(state)).toBeUndefined();
  });

  it('steps from the width drawn, held to the limits of the moment, when the window shrank after the drag', () => {
    const { container, state } = shown({ stageWidth: 1440 });
    press(handle(container), 1000);
    move(handle(container), 0);
    frame();
    release(handle(container), 0);
    expect(sizeOf(state)).toBe(480);
    act(() => stub?.resize(stage(container), 800));
    expect(handle(container).getAttribute('aria-valuenow')).toBe('368');
    key(container, 'ArrowRight');
    expect(sizeOf(state)).toBe(352);
  });
});

describe('a store that throws while a drag is being written', () => {
  function twoPanels() {
    stub = undefined;
    const state = createClientState();
    const { container, panels } = renderApp('/explore', client, state);
    act(() => {
      panels.register(inspector);
      panels.register({ id: 'legend', title: 'Legend', placement: { kind: 'floating', side: 'right', top: 64 }, content: () => <p>Legend body</p> });
    });
    const legendHandle = within(screen.getByRole('complementary', { name: 'Legend' })).getByRole('separator', { name: 'Resize Legend' });
    return { container, state, legendHandle };
  }

  it('ends a released drag whose last write throws, lets the error through, and leaves keys and another handle free to work', () => {
    const { container, state, legendHandle } = twoPanels();
    press(handle(container), 1000);
    move(handle(container), 960);
    frame();
    move(handle(container), 900);
    release(handle(container), 900);
    let throwOnce = true;
    state.presentation.view.subscribe(() => {
      if (!throwOnce) return;
      throwOnce = false;
      throw new Error('subscriber failed');
    });
    expect(() => frame()).toThrow('subscriber failed');
    expect(document.body.classList.contains('panel-resizing')).toBe(false);
    expect(fireEvent.keyDown(legendHandle, { key: 'Home' })).toBe(false);
    expect(state.presentation.view.getState().panelSizes.get('legend')).toBe(240);
    fireEvent.pointerDown(legendHandle, { button: 0, pointerId: 3, clientX: 500 });
    expect(document.body.classList.contains('panel-resizing')).toBe(true);
    fireEvent.pointerMove(legendHandle, { pointerId: 3, clientX: 400 });
    frame();
    fireEvent.pointerUp(legendHandle, { pointerId: 3, clientX: 400 });
    expect(state.presentation.view.getState().panelSizes.get('legend')).toBe(340);
    expect(document.body.classList.contains('panel-resizing')).toBe(false);
  });

  it('ends a drag that is cancelled when putting the width back throws, and lets the error through', () => {
    const { container, state, legendHandle } = twoPanels();
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const errors: unknown[] = [];
    const record = (event: ErrorEvent): void => {
      event.preventDefault();
      errors.push(event.error);
    };
    window.addEventListener('error', record);
    press(handle(container), 1000);
    move(handle(container), 960);
    frame();
    expect(sizeOf(state)).toBe(360);
    let throwOnce = true;
    state.presentation.view.subscribe(() => {
      if (!throwOnce) return;
      throwOnce = false;
      throw new Error('subscriber failed');
    });
    act(() => void fireEvent.blur(window));
    window.removeEventListener('error', record);
    reported.mockRestore();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(new Error('subscriber failed'));
    expect(document.body.classList.contains('panel-resizing')).toBe(false);
    expect(fireEvent.keyDown(legendHandle, { key: 'Home' })).toBe(false);
    expect(state.presentation.view.getState().panelSizes.get('legend')).toBe(240);
  });
});

describe('the width after a resize', () => {
  it('is kept through a collapse and an expand, and through taking the panel out and registering it again', () => {
    const { container, state, panels, remove } = shown();
    press(handle(container), 1000);
    move(handle(container), 900);
    frame();
    release(handle(container), 900);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Inspector' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand Inspector' }));
    expect(column(container)?.style.width).toBe('452px');
    act(() => remove());
    act(() => {
      panels.register(inspector);
    });
    expect(column(container)?.style.width).toBe('452px');
    expect(sizeOf(state)).toBe(420);
  });
});

describe('the resize handle as a splitter', () => {
  const key = (container: HTMLElement, name: string, init: Record<string, unknown> = {}) => fireEvent.keyDown(handle(container), { key: name, ...init });

  it('is reachable with Tab and carries the splitter attributes, the name and what it controls', () => {
    const { container } = shown({ stageWidth: 1440 });
    const edge = handle(container);
    expect(edge.getAttribute('role')).toBe('separator');
    expect(edge.getAttribute('aria-orientation')).toBe('vertical');
    expect(edge.getAttribute('aria-label')).toBe('Resize Inspector');
    expect(edge.tabIndex).toBe(0);
    expect(document.getElementById(edge.getAttribute('aria-controls') ?? '')).toBe(container.querySelector('.panel'));
    expect(edge.getAttribute('aria-valuenow')).toBe('320');
    expect(edge.getAttribute('aria-valuemin')).toBe('240');
    expect(edge.getAttribute('aria-valuemax')).toBe('480');
  });

  it('is reached in the tab order before the collapse button', () => {
    const { container } = shown();
    const order = [...container.querySelectorAll<HTMLElement>('[tabindex="0"], button')].filter((element) => element.closest('.panel-frame'));
    expect(order.map((element) => element.getAttribute('aria-label'))).toEqual(['Resize Inspector', 'Collapse Inspector']);
  });

  it('widens a right-docked panel by 16 px with ArrowLeft and narrows it by 16 px with ArrowRight, by 64 with Shift, and the attributes follow', () => {
    const { container, state } = shown({ stageWidth: 1440 });
    handle(container).focus();
    key(container, 'ArrowLeft');
    expect(sizeOf(state)).toBe(336);
    expect(handle(container).getAttribute('aria-valuenow')).toBe('336');
    key(container, 'ArrowLeft', { shiftKey: true });
    expect(sizeOf(state)).toBe(400);
    key(container, 'ArrowRight');
    expect(sizeOf(state)).toBe(384);
    key(container, 'ArrowRight', { shiftKey: true });
    expect(sizeOf(state)).toBe(320);
    expect(column(container)?.style.width).toBe('352px');
    expect(document.activeElement).toBe(handle(container));
  });

  it('sets the minimum with Home and the maximum with End, and never passes a limit', () => {
    const { container, state } = shown({ stageWidth: 1440 });
    key(container, 'End');
    expect(sizeOf(state)).toBe(480);
    key(container, 'ArrowLeft', { shiftKey: true });
    expect(sizeOf(state)).toBe(480);
    key(container, 'Home');
    expect(sizeOf(state)).toBe(240);
    key(container, 'ArrowRight', { shiftKey: true });
    expect(sizeOf(state)).toBe(240);
    expect(handle(container).getAttribute('aria-valuenow')).toBe('240');
  });

  it('stops at the limit of a narrow window and lets the maximum win below 240', () => {
    const { container, state } = shown({ stageWidth: 540 });
    expect(handle(container).getAttribute('aria-valuemin')).toBe('238');
    expect(handle(container).getAttribute('aria-valuemax')).toBe('238');
    key(container, 'ArrowLeft');
    key(container, 'Home');
    key(container, 'End');
    expect(handle(container).getAttribute('aria-valuenow')).toBe('238');
    expect(sizeOf(state)).toBeUndefined();
  });

  it('does not swallow any other key, and changes nothing for it', () => {
    const { container, state } = shown();
    for (const name of ['a', 'Enter', ' ', 'ArrowUp', 'ArrowDown', 'Tab', 'PageUp']) expect(key(container, name)).toBe(true);
    expect(sizeOf(state)).toBeUndefined();
    expect(key(container, 'ArrowLeft')).toBe(false);
  });

  it('leaves the width alone when an input inside the panel has the focus', () => {
    const state = createClientState();
    const { container, panels } = renderApp('/explore', client, state);
    act(() => {
      panels.register({ ...inspector, content: () => <input aria-label="Notes" /> });
    });
    const input = screen.getByRole('textbox', { name: 'Notes' });
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    fireEvent.keyDown(input, { key: 'End' });
    expect(sizeOf(state)).toBeUndefined();
    expect(column(container)?.style.width).toBe('352px');
  });

  it('has no handle to focus when collapsed, and a handle at the stored width held to the limits when expanded again', () => {
    const { container, state } = shown({ stageWidth: 1440, stored: 460 });
    handle(container).focus();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Inspector' }));
    expect(container.querySelector('[role="separator"]')).toBeNull();
    act(() => stub?.resize(stage(container), 700));
    fireEvent.click(screen.getByRole('button', { name: 'Expand Inspector' }));
    expect(handle(container).getAttribute('aria-valuenow')).toBe('318');
    expect(handle(container).getAttribute('aria-valuemax')).toBe('318');
    expect(sizeOf(state)).toBe(460);
  });

  it('shows the width drawn, not the stored one, when the stored width is above the maximum of the window, and does not overwrite the stored width at the limit', () => {
    const { container, state } = shown({ stageWidth: 800, stored: 460 });
    expect(handle(container).getAttribute('aria-valuenow')).toBe('368');
    key(container, 'ArrowLeft');
    expect(sizeOf(state)).toBe(460);
    key(container, 'ArrowRight');
    expect(sizeOf(state)).toBe(352);
    expect(handle(container).getAttribute('aria-valuenow')).toBe('352');
  });
});

describe('resizing a floating panel', () => {
  function floatingShown(side: 'left' | 'right', extra: { readonly stored?: number; readonly canvasWidth?: number } = {}) {
    stub = stubSizeObserver();
    const state = createClientState();
    const rendered = renderApp('/explore', client, state);
    act(() => {
      rendered.panels.register({ id: 'legend', title: 'Legend', placement: { kind: 'floating', side, top: 64 }, content: () => <p>Legend body</p> });
    });
    const layer = need(rendered.container.querySelector<HTMLElement>('.panel-layer'), 'the panel layer');
    act(() => stub?.resize(layer, extra.canvasWidth ?? 1000, 700));
    if (extra.stored !== undefined) act(() => state.presentation.setPanelSize('legend', extra.stored ?? 0));
    const edge = () => within(screen.getByRole('complementary', { name: 'Legend' })).getByRole('separator', { name: 'Resize Legend' });
    const widthOf = () => rendered.container.querySelector<HTMLElement>('.floating-panel')?.style.width;
    return { ...rendered, state, edge, widthOf, stored: () => state.presentation.view.getState().panelSizes.get('legend') };
  }

  it('widens a right-anchored panel for a drag to the left and narrows it for a drag to the right, and the handle is on its left edge', () => {
    const { edge, widthOf, stored, container } = floatingShown('right');
    expect(container.querySelector('.floating-panel .panel-frame')?.className).toBe('panel-frame');
    press(edge(), 500);
    move(edge(), 450);
    frame();
    expect(widthOf()).toBe('370px');
    move(edge(), 560);
    frame();
    expect(stored()).toBe(260);
    release(edge(), 560);
  });

  it('is the mirror for a left-anchored panel: its handle is on its right edge, a drag to the right widens it and a drag to the left narrows it', () => {
    const { edge, widthOf, stored, container } = floatingShown('left');
    expect(container.querySelector('.floating-panel .panel-frame')?.className).toBe('panel-frame panel-frame-left');
    press(edge(), 500);
    move(edge(), 550);
    frame();
    expect(widthOf()).toBe('370px');
    move(edge(), 440);
    frame();
    expect(stored()).toBe(260);
    release(edge(), 440);
    expect(widthOf()).toBe('260px');
  });

  it('is the mirror from the keyboard: ArrowRight widens a left-anchored panel and ArrowLeft narrows it, Shift by 64, with Home and End setting the minimum and the maximum', () => {
    const { edge, widthOf, stored } = floatingShown('left');
    const key = (name: string, init: Record<string, unknown> = {}) => fireEvent.keyDown(edge(), { key: name, ...init });
    key('ArrowRight');
    expect(stored()).toBe(336);
    key('ArrowRight', { shiftKey: true });
    expect(stored()).toBe(400);
    key('ArrowLeft');
    expect(stored()).toBe(384);
    key('ArrowLeft', { shiftKey: true });
    expect(stored()).toBe(320);
    key('End');
    expect(widthOf()).toBe('480px');
    key('Home');
    expect(widthOf()).toBe('240px');
    key('ArrowLeft', { shiftKey: true });
    expect(stored()).toBe(240);
  });

  it('is not mirrored for a right-anchored panel from the keyboard: ArrowLeft widens it', () => {
    const { edge, stored } = floatingShown('right');
    fireEvent.keyDown(edge(), { key: 'ArrowLeft' });
    expect(stored()).toBe(336);
    fireEvent.keyDown(edge(), { key: 'ArrowRight' });
    expect(stored()).toBe(320);
  });

  it('stops at the effective limits of the canvas: the maximum is the canvas less 32 and wins below 240', () => {
    const { edge, widthOf, stored } = floatingShown('right', { canvasWidth: 400 });
    fireEvent.keyDown(edge(), { key: 'End' });
    expect(widthOf()).toBe('368px');
    expect(edge().getAttribute('aria-valuemax')).toBe('368');
    expect(stored()).toBe(368);
  });

  it('lets the maximum win in a canvas narrower than the minimum plus 32', () => {
    const { edge, widthOf, stored } = floatingShown('left', { canvasWidth: 250 });
    expect(edge().getAttribute('aria-valuemin')).toBe('218');
    expect(edge().getAttribute('aria-valuemax')).toBe('218');
    fireEvent.keyDown(edge(), { key: 'ArrowRight' });
    fireEvent.keyDown(edge(), { key: 'Home' });
    expect(widthOf()).toBe('218px');
    expect(stored()).toBeUndefined();
  });

  it('cancels a drag when the panel is collapsed, as the dock\'s does, and keeps its size apart from the dock\'s', () => {
    const { edge, widthOf, stored } = floatingShown('right');
    press(edge(), 500);
    move(edge(), 400);
    frame();
    expect(stored()).toBe(420);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Legend' }));
    expect(stored()).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Legend' }));
    expect(widthOf()).toBe('320px');
  });
});
