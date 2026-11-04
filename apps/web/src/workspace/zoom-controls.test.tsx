import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { GraphCanvas } from '../canvas/graph-canvas.js';
import { RendererProvider } from '../canvas/renderer-context.js';
import type { CreateRenderer } from '../canvas/scene.js';
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '../canvas/zoom.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { key, ref, result } from '../state/test-data.js';
import { stubFactory, type StubOptions } from '../test-utils.js';
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
