import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { clientWith, me, need, renderApp, source, stubSizeObserver } from '../test-utils.js';
import type { PanelEntry } from '../workspace/panel-registry.js';
import { bindAssistantPanel } from './assistant-binder.js';
import { ASSISTANT_PANEL_ID } from './panel-layout.js';

const client = clientWith({ me: me(), sources: [source('a')] });

let stub: ReturnType<typeof stubSizeObserver> | undefined;
let unbind: (() => void) | undefined;
const original = window.innerWidth;
afterEach(() => {
  unbind?.();
  unbind = undefined;
  stub?.restore();
  stub = undefined;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: original });
});

const setWindow = (width: number): void => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => void window.dispatchEvent(new Event('resize')));
};

function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount(count + 1)}>
      Held {count}
    </button>
  );
}

async function openAssistant(windowWidth: number, canvasWidth: number, extra: readonly PanelEntry[] = []) {
  stub = stubSizeObserver();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: windowWidth });
  const state = createClientState();
  const { container, panels } = renderApp('/explore', client, state);
  await screen.findByText('Local workspace');
  unbind = bindAssistantPanel(state, panels);
  act(() => {
    state.presentation.setAssistantOpen(true);
    for (const entry of extra) panels.register(entry);
  });
  const layer = need(container.querySelector<HTMLElement>('.panel-layer'), 'the panel layer');
  act(() => stub?.resize(layer, canvasWidth, 700));
  const box = (id: string) => need(container.querySelector<HTMLElement>(`[data-panel="${id}"]`)?.closest<HTMLElement>('.floating-panel'), id);
  const wide = () => screen.getByRole('button', { name: /^(Wide|Normal width)$/ });
  return { state, layer, box, wide };
}

describe('the Assistant panel drawn by the panel host', () => {
  it('draws the header icons in the order of the frame: Wide, Pop out, Close', async () => {
    const { box } = await openAssistant(1400, 1000);
    const names = [...box(ASSISTANT_PANEL_ID).querySelectorAll('.ask-head button')].map((button) => button.getAttribute('aria-label'));
    expect(names).toEqual(['Wide', 'Pop out', 'Close']);
  });

  it('reaches the limit of a narrow window by End on its handle, starting below it, where the Wide button is disabled and not pressed', async () => {
    const { state, box, wide } = await openAssistant(600, 544);
    act(() => state.presentation.setPanelSize(ASSISTANT_PANEL_ID, 300));
    expect(box(ASSISTANT_PANEL_ID).style.width).toBe('300px');
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize Assistant' }), { key: 'End' });
    expect(box(ASSISTANT_PANEL_ID).style.width).toBe('360px');
    expect(wide().hasAttribute('disabled')).toBe(true);
    expect(wide().getAttribute('aria-pressed')).toBe('false');
  });

  it('reaches the limit of a narrow window by dragging the handle, starting below it, with the Wide button disabled and not pressed', async () => {
    const { state, box, wide } = await openAssistant(600, 544);
    act(() => state.presentation.setPanelSize(ASSISTANT_PANEL_ID, 300));
    vi.useFakeTimers();
    try {
      const handle = screen.getByRole('separator', { name: 'Resize Assistant' });
      fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 300 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 40 });
      fireEvent.pointerUp(handle, { pointerId: 1, clientX: 40 });
      act(() => void vi.advanceTimersByTime(40));
    } finally {
      vi.useRealTimers();
    }
    expect(box(ASSISTANT_PANEL_ID).style.width).toBe('360px');
    expect(wide().hasAttribute('disabled')).toBe(true);
    expect(wide().getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps a panel in wide mode at 60% of the window as the window changes: narrower, then wider than the window Wide was pressed in, with the button pressed throughout', async () => {
    const { box, wide, layer } = await openAssistant(1440, 1384);
    await userEvent.click(wide());
    expect(box(ASSISTANT_PANEL_ID).style.width).toBe('864px');
    expect(wide().getAttribute('aria-pressed')).toBe('true');
    setWindow(1100);
    act(() => stub?.resize(layer, 1044, 700));
    expect(box(ASSISTANT_PANEL_ID).style.width).toBe('660px');
    expect(wide().getAttribute('aria-pressed')).toBe('true');
    setWindow(1800);
    act(() => stub?.resize(layer, 1744, 700));
    expect(box(ASSISTANT_PANEL_ID).style.width).toBe('1080px');
    expect(wide().getAttribute('aria-pressed')).toBe('true');
  });

  it('ends wide mode when the panel is dragged: a later wider window leaves the dragged width', async () => {
    const { state, box, wide, layer } = await openAssistant(1440, 1384);
    await userEvent.click(wide());
    vi.useFakeTimers();
    try {
      const handle = screen.getByRole('separator', { name: 'Resize Assistant' });
      fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 560 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 760 });
      fireEvent.pointerUp(handle, { pointerId: 1, clientX: 760 });
      act(() => void vi.advanceTimersByTime(40));
    } finally {
      vi.useRealTimers();
    }
    expect(box(ASSISTANT_PANEL_ID).style.width).toBe('664px');
    expect(state.presentation.view.getState().panelSizes.get(ASSISTANT_PANEL_ID)).toBe(664);
    setWindow(1800);
    act(() => stub?.resize(layer, 1744, 700));
    expect(box(ASSISTANT_PANEL_ID).style.width).toBe('664px');
    expect(wide().getAttribute('aria-pressed')).toBe('false');
  });

  it('moves an inspector that is open beside the panel when Wide is pressed, without closing it or losing what it holds, and sizes it to the space left when the window is made narrower', async () => {
    const side: PanelEntry = { id: 'inspector', title: 'Inspector', placement: { kind: 'floating', side: 'right', top: 64, beside: ASSISTANT_PANEL_ID }, content: Counter };
    const { box, wide, layer } = await openAssistant(1440, 1384, [side]);
    expect(box('inspector').style.right).toBe('412px');
    await userEvent.click(screen.getByRole('button', { name: 'Held 0' }));
    await userEvent.click(wide());
    expect(box('inspector').style.right).toBe('896px');
    expect(screen.getByRole('button', { name: 'Held 1' })).toBeTruthy();
    setWindow(1000);
    act(() => stub?.resize(layer, 944, 700));
    expect(box(ASSISTANT_PANEL_ID).style.width).toBe('600px');
    expect(box('inspector').style.right).toBe('632px');
    expect(box('inspector').style.width).toBe('296px');
  });
});
