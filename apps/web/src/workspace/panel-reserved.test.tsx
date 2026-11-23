import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { clientWith, me, need, renderApp, source, stubSizeObserver } from '../test-utils.js';
import type { PanelEntry } from './panel-registry.js';

const client = clientWith({ me: me(), sources: [source('a')] });
let stub: ReturnType<typeof stubSizeObserver> | undefined;
const originalWidth = window.innerWidth;
afterEach(() => {
  stub?.restore();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
});

const panel = (id: string, side: 'left' | 'right', extra: Partial<PanelEntry> = {}): PanelEntry => ({ id, title: id, placement: { kind: 'floating', side, top: 16 }, content: () => <p>{id} body</p>, ...extra });

async function open(entries: readonly PanelEntry[]) {
  stub = stubSizeObserver();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1500 });
  const state = createClientState();
  const { container, panels } = renderApp('/explore', client, state);
  await screen.findByText('Local workspace');
  act(() => {
    for (const entry of entries) panels.register(entry);
  });
  const layer = need(container.querySelector<HTMLElement>('.panel-layer'), 'the panel layer');
  act(() => stub?.resize(layer, 1384, 700));
  const region = need(container.querySelector<HTMLElement>('.canvas-region'), 'the canvas region');
  return { region, panels };
}

describe('the reach of the right-hand panels, given to the canvas region', () => {
  it('is the distance from the right edge to the left edge of the leftmost right-hand panel, and is not there without one', async () => {
    const { region } = await open([panel('legend', 'right', { initialWidth: 400 })]);
    expect(region.style.getPropertyValue('--panel-reserved-right')).toBe('416px');
    expect(region.hasAttribute('data-panels-right')).toBe(true);
  });

  it('counts a panel hung beside another as part of the reach, and follows the width the first one is drawn at', async () => {
    const side: PanelEntry = { id: 'inspector', title: 'inspector', placement: { kind: 'floating', side: 'right', top: 16, beside: 'legend' }, content: () => <p>inspector body</p> };
    const { region } = await open([panel('legend', 'right', { initialWidth: 400 }), side]);
    expect(region.style.getPropertyValue('--panel-reserved-right')).toBe('752px');
  });

  it('gives a left-hand panel its own reach, from the left edge, and none to the right side', async () => {
    const { region } = await open([{ ...panel('filters', 'left'), placement: { kind: 'floating', side: 'left', top: 64, inset: 72 }, initialWidth: 320 }]);
    expect(region.style.getPropertyValue('--panel-reserved-left')).toBe('392px');
    expect(region.hasAttribute('data-panels-left')).toBe(true);
    expect(region.hasAttribute('data-panels-right')).toBe(false);
    expect(region.style.getPropertyValue('--panel-reserved-right')).toBe('');
  });

  it('is taken away when the panel is taken out', async () => {
    const { region, panels } = await open([panel('filters', 'left')]);
    let remove: () => void = () => undefined;
    act(() => {
      remove = panels.register(panel('legend', 'right'));
    });
    expect(region.style.getPropertyValue('--panel-reserved-right')).toBe('336px');
    act(() => remove());
    expect(region.style.getPropertyValue('--panel-reserved-right')).toBe('');
    expect(region.hasAttribute('data-panels-right')).toBe(false);
  });

  const search = (): PanelEntry => ({ ...panel('search', 'left'), placement: { kind: 'floating', side: 'left', top: 64, inset: 72 }, initialWidth: 320 });

  it('marks the hint and the notice as having no room when the panels leave less than 160 px between them', async () => {
    const { region } = await open([search(), panel('assistant', 'right', { initialWidth: 864, widestShareOfWindow: 1 })]);
    expect(region.hasAttribute('data-no-room-hint')).toBe(true);
    expect(region.hasAttribute('data-no-room-notice')).toBe(true);
  });

  it('keeps the notice when only the hint has no room: the hint starts clear of the tool strip, the notice 16 px from the edge', async () => {
    const { region } = await open([panel('assistant', 'right', { initialWidth: 1166, widestShareOfWindow: 1 })]);
    expect(region.hasAttribute('data-no-room-hint')).toBe(true);
    expect(region.hasAttribute('data-no-room-notice')).toBe(false);
  });

  it('marks nothing when the panels leave room', async () => {
    const { region } = await open([panel('assistant', 'right', { initialWidth: 1000, widestShareOfWindow: 1 })]);
    expect(region.hasAttribute('data-no-room-hint')).toBe(false);
    expect(region.hasAttribute('data-no-room-notice')).toBe(false);
  });

  it('marks nothing with a left panel and a normal right panel', async () => {
    const { region } = await open([search(), panel('assistant', 'right', { initialWidth: 380, widestShareOfWindow: 1 })]);
    expect(region.hasAttribute('data-no-room-hint')).toBe(false);
    expect(region.hasAttribute('data-no-room-notice')).toBe(false);
  });

  it('marks the notice as having no room with a left panel alone when less than 160 px is left between its reach and the edge gap', async () => {
    const wide: PanelEntry = { ...search(), initialWidth: 1130, widestShareOfWindow: 1 };
    const { region } = await open([wide]);
    expect(region.hasAttribute('data-no-room-notice')).toBe(true);
    expect(region.hasAttribute('data-no-room-hint')).toBe(false);
  });

  it('starts a panel below the scope lines when it would overlap them horizontally, and keeps its place when it does not', async () => {
    const { region } = await open([panel('assistant', 'right', { initialWidth: 864, widestShareOfWindow: 1 }), { ...panel('inspector', 'right'), placement: { kind: 'floating', side: 'right', top: 16, beside: 'assistant' }, initialWidth: 320 }]);
    const scope = document.createElement('div');
    scope.className = 'graph-scope';
    await act(async () => {
      region.appendChild(scope);
      await Promise.resolve();
    });
    act(() => stub?.resize(scope, 396, 44));
    const box = (id: string) => need(region.querySelector<HTMLElement>(`[data-panel="${id}"]`)?.closest<HTMLElement>('.floating-panel'), id);
    expect(box('inspector').style.top).toBe('60px');
    expect(box('assistant').style.top).toBe('16px');
    act(() => stub?.resize(scope, 396, 94));
    expect(box('inspector').style.top).toBe('110px');
  });

  it('places the panels again when an obstacle moves without changing size and a style is written on the region', async () => {
    const { region } = await open([panel('assistant', 'right', { initialWidth: 864, widestShareOfWindow: 1 }), { ...panel('inspector', 'right'), placement: { kind: 'floating', side: 'right', top: 16, beside: 'assistant' }, initialWidth: 320 }]);
    const scope = document.createElement('div');
    scope.className = 'graph-scope';
    await act(async () => {
      region.appendChild(scope);
      await Promise.resolve();
    });
    act(() => stub?.resize(scope, 396, 44));
    const box = (id: string) => need(region.querySelector<HTMLElement>(`[data-panel="${id}"]`)?.closest<HTMLElement>('.floating-panel'), id);
    expect(box('inspector').style.top).toBe('60px');
    scope.getBoundingClientRect = () => ({ ...scope.ownerDocument.body.getBoundingClientRect(), left: 0, top: 20, width: 396, height: 44 });
    await act(async () => {
      region.style.setProperty('--moved', '1');
      await Promise.resolve();
    });
    expect(box('inspector').style.top).toBe('80px');
  });
});
