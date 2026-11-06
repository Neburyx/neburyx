import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphCanvas, RENDERER_UNAVAILABLE } from '../canvas/graph-canvas.js';
import { RendererProvider } from '../canvas/renderer-context.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { INITIAL_PRESENTATION } from '../state/presentation-state.js';
import { key, ref, result } from '../state/test-data.js';
import { builtInKeyBindings, stubFactory, type StubOptions } from '../test-utils.js';
import { registerBuiltInTools } from './built-in-tools.js';
import { KeyBindingsProvider } from './key-binding-registry.js';
import { createToolRegistry, EXPLORE_TOOL_ID, ToolsProvider, type ToolEntry, type ToolRegistry } from './tool-registry.js';
import { ToolStrip } from './tool-strip.js';

function load(state: ClientState): void {
  state.bindSource('a');
  state.putResult(key('a'), result('a', ['n1', 'n2'], []));
  state.setLoaded([key('a')], [ref('a', 'type-a', 'n1'), ref('a', 'type-a', 'n2')], []);
}

function show(state: ClientState, registry: ToolRegistry, options: StubOptions = {}, outside?: () => void) {
  const factory = stubFactory(options);
  const view = render(
    <ClientStateProvider state={state}>
      <ToolsProvider registry={registry}>
        <KeyBindingsProvider registry={builtInKeyBindings()}>
          <RendererProvider createRenderer={factory.create}>
            <GraphCanvas />
            <ToolStrip />
            <button type="button" onClick={outside}>Outside</button>
          </RendererProvider>
        </KeyBindingsProvider>
      </ToolsProvider>
    </ClientStateProvider>,
  );
  return { made: factory.made, unmount: view.unmount };
}

function withExplore(): ToolRegistry {
  const registry = createToolRegistry();
  registerBuiltInTools(registry);
  return registry;
}

const registrationOf = (registry: ToolRegistry, id: string): number => registry.view.getState().find((entry) => entry.id === id)?.registration ?? -1;
const action = (id: string, activate: () => void = () => undefined, order = 100): ToolEntry => ({ id, label: id, icon: <span aria-hidden="true">{id}</span>, order, kind: { type: 'action', activate } });
const flyoutTool = (id: string, order = 100): ToolEntry => ({ id, label: id, icon: null, order, kind: { type: 'flyout', content: () => <p>{id} flyout</p> } });
const names = (): string[] => within(screen.getByRole('group', { name: 'Tools' })).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? '');
const tool = (name: string): HTMLElement => screen.getByRole('button', { name });
const isActive = (name: string): boolean => tool(name).dataset.active === 'true';

describe('the tool strip', () => {
  it('renders nothing when no tool is registered, and nothing when the last one is taken out', () => {
    const registry = createToolRegistry();
    const remove = registry.register(action('stand-in'));
    const state = createClientState();
    const { container } = render(
      <ClientStateProvider state={state}>
        <ToolsProvider registry={registry}>
          <ToolStrip />
        </ToolsProvider>
      </ClientStateProvider>,
    );
    expect(screen.queryByRole('group', { name: 'Tools' })).not.toBeNull();
    act(() => remove());
    expect(screen.queryByRole('group', { name: 'Tools' })).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('shows Explore alone from the built-in registration, with the Explore name', () => {
    show(createClientState(), withExplore());
    expect(names()).toEqual(['Explore']);
  });

  it('shows a tool a test registers, in its order, and hides it again when it is taken out', () => {
    const registry = withExplore();
    show(createClientState(), registry);
    let remove = (): void => undefined;
    act(() => {
      remove = registry.register(action('stand-in', undefined, 5));
    });
    expect(names()).toEqual(['stand-in', 'Explore']);
    act(() => remove());
    expect(names()).toEqual(['Explore']);
  });

  it('highlights Explore while no flyout is open and moves the highlight to the tool whose flyout opens', async () => {
    const registry = withExplore();
    registry.register(flyoutTool('other', 20));
    show(createClientState(), registry);
    expect(isActive('Explore')).toBe(true);
    expect(isActive('other')).toBe(false);
    await userEvent.setup().click(tool('other'));
    expect(screen.getByText('other flyout')).not.toBeNull();
    expect(isActive('other')).toBe(true);
    expect(isActive('Explore')).toBe(false);
  });

  it('runs the activation of an action tool once when it is pressed and does not highlight it', async () => {
    const registry = withExplore();
    const activate = vi.fn();
    registry.register(action('panel', activate, 20));
    const state = createClientState();
    show(state, registry);
    await userEvent.setup().click(tool('panel'));
    expect(activate).toHaveBeenCalledTimes(1);
    expect(isActive('panel')).toBe(false);
    expect(isActive('Explore')).toBe(true);
    expect(state.presentation.view.getState().openTool).toBeUndefined();
  });

  it('highlights an action tool that says it is active, and not Explore, for as long as it says so, and marks it pressed; one that never says so is not marked', () => {
    const registry = withExplore();
    registry.register({ ...action('panel', undefined, 20), kind: { type: 'action', activate: () => undefined, isActive: (presentation) => presentation.legendOpen } });
    registry.register(action('plain', undefined, 30));
    const state = createClientState();
    show(state, registry);
    expect(isActive('panel')).toBe(false);
    expect(isActive('Explore')).toBe(true);
    expect(tool('panel').getAttribute('aria-pressed')).toBe('false');
    expect(tool('plain').hasAttribute('aria-pressed')).toBe(false);
    act(() => state.presentation.setLegendOpen(true));
    expect(isActive('panel')).toBe(true);
    expect(isActive('Explore')).toBe(false);
    expect(tool('panel').getAttribute('aria-pressed')).toBe('true');
    act(() => state.presentation.setLegendOpen(false));
    expect(isActive('panel')).toBe(false);
    expect(isActive('Explore')).toBe(true);
  });

  it('highlights nothing when Explore is not registered and no flyout is open', () => {
    const registry = createToolRegistry();
    registry.register(action('panel'));
    show(createClientState(), registry);
    expect(isActive('panel')).toBe(false);
  });

  it('ignores an open tool that is not registered, or is not a flyout, and draws no flyout for it', () => {
    const registry = withExplore();
    registry.register(action('panel', undefined, 20));
    const state = createClientState();
    show(state, registry);
    act(() => state.presentation.setOpenTool({ id: 'panel', registration: registrationOf(registry, 'panel') }));
    expect(isActive('Explore')).toBe(true);
    act(() => state.presentation.setOpenTool({ id: 'missing', registration: 1 }));
    expect(screen.queryByRole('menu', { name: 'Explore' })).toBeNull();
  });
});

describe('the Explore flyout', () => {
  const row = (name: string): HTMLElement => within(screen.getByRole('menu', { name: 'Explore' })).getByRole(['Select', 'Pan', 'Box select'].includes(name) ? 'menuitemradio' : 'menuitem', { name });

  it('opens beside the strip with the header and the three modes with their hints, the current mode chosen', async () => {
    show(createClientState(), withExplore());
    expect(screen.queryByRole('menu', { name: 'Explore' })).toBeNull();
    await userEvent.setup().click(tool('Explore'));
    const flyout = screen.getByRole('menu', { name: 'Explore' });
    expect(within(flyout).getByText('Explore')).not.toBeNull();
    expect(within(flyout).getAllByRole('menuitemradio').map((button) => button.textContent)).toEqual(['SelectV', 'PanH', 'Box selectB']);
    expect(row('Select').getAttribute('aria-checked')).toBe('true');
    expect(row('Pan').getAttribute('aria-checked')).toBe('false');
    expect(row('Box select').getAttribute('aria-checked')).toBe('false');
    expect(isActive('Explore')).toBe(true);
  });

  it('switches the mode that reaches the renderer when a row is chosen, closes, and puts the focus on the Explore button', async () => {
    const state = createClientState();
    load(state);
    const factory = show(state, withExplore());
    const user = userEvent.setup();
    for (const [name, mode] of [['Pan', 'pan'], ['Select', 'select'], ['Box select', 'box']] as const) {
      await user.click(tool('Explore'));
      await user.click(row(name));
      expect(state.presentation.view.getState().tool).toBe(mode);
      expect(factory.made[0]?.scenes.at(-1)?.tool).toBe(mode);
      expect(screen.queryByRole('menu', { name: 'Explore' })).toBeNull();
      expect(document.activeElement).toBe(tool('Explore'));
    }
    await user.click(tool('Explore'));
    expect(row('Box select').getAttribute('aria-checked')).toBe('true');
    expect(row('Select').getAttribute('aria-checked')).toBe('false');
  });

  it('closes and leaves the mode as it was when the mode already chosen is chosen again', async () => {
    const state = createClientState();
    show(state, withExplore());
    const user = userEvent.setup();
    await user.click(tool('Explore'));
    await user.click(row('Select'));
    expect(state.presentation.view.getState().tool).toBe('select');
    expect(screen.queryByRole('menu', { name: 'Explore' })).toBeNull();
  });

  it('changes only the open tool when it opens and closes, and starts closed', async () => {
    const state = createClientState();
    show(state, withExplore());
    const before = state.presentation.view.getState();
    expect(before.openTool).toBeUndefined();
    const user = userEvent.setup();
    await user.click(tool('Explore'));
    const open = state.presentation.view.getState();
    expect(open.openTool).toEqual({ id: EXPLORE_TOOL_ID, registration: expect.any(Number) });
    expect({ ...open, openTool: undefined }).toEqual({ ...before, openTool: undefined });
    expect(open.selection).toBe(before.selection);
    expect(open.viewport).toBe(before.viewport);
    await user.click(row('Pan'));
    const closed = state.presentation.view.getState();
    expect(closed.openTool).toBeUndefined();
    expect({ ...closed, tool: 'select' }).toEqual({ ...before, tool: 'select' });
    expect(INITIAL_PRESENTATION.openTool).toBeUndefined();
  });
});

describe('closing the flyout', () => {
  const flyout = (): HTMLElement | null => screen.queryByRole('menu', { name: 'Explore' });
  const row = (name: string): HTMLElement => within(screen.getByRole('menu', { name: 'Explore' })).getByRole(['Select', 'Pan', 'Box select'].includes(name) ? 'menuitemradio' : 'menuitem', { name });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes on a second press of the button and leaves the mode alone', async () => {
    const state = createClientState();
    show(state, withExplore());
    const user = userEvent.setup();
    await user.click(tool('Explore'));
    expect(flyout()).not.toBeNull();
    await user.click(tool('Explore'));
    expect(flyout()).toBeNull();
    expect(state.presentation.view.getState().tool).toBe('select');
    expect(state.presentation.view.getState().openTool).toBeUndefined();
  });

  it('closes on a press outside the strip and the flyout and the press still does what it does, but not on a press inside the flyout that chooses nothing', async () => {
    const state = createClientState();
    const outside = vi.fn();
    show(state, withExplore(), {}, outside);
    const user = userEvent.setup();
    await user.click(tool('Explore'));
    await user.click(within(screen.getByRole('menu', { name: 'Explore' })).getByText('Explore'));
    expect(flyout()).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(flyout()).toBeNull();
    expect(outside).toHaveBeenCalledTimes(1);
    expect(state.presentation.view.getState().tool).toBe('select');
  });

  it('closes on Escape with the focus inside the flyout and puts the focus on the button, and does nothing on Escape with the focus outside it', async () => {
    const state = createClientState();
    show(state, withExplore());
    const user = userEvent.setup();
    await user.click(tool('Explore'));
    screen.getByRole('button', { name: 'Outside' }).focus();
    await user.keyboard('{Escape}');
    expect(flyout()).not.toBeNull();
    act(() => row('Pan').focus());
    await user.keyboard('{Escape}');
    expect(flyout()).toBeNull();
    expect(document.activeElement).toBe(tool('Explore'));
    expect(state.presentation.view.getState().tool).toBe('select');
  });

  it('keeps one flyout open at most', async () => {
    const registry = withExplore();
    registry.register(flyoutTool('other', 20));
    const state = createClientState();
    show(state, registry);
    const user = userEvent.setup();
    await user.click(tool('Explore'));
    expect(flyout()).not.toBeNull();
    await user.click(tool('other'));
    expect(flyout()).toBeNull();
    expect(screen.getByText('other flyout')).not.toBeNull();
    expect(state.presentation.view.getState().openTool?.id).toBe('other');
    await user.click(tool('Explore'));
    expect(screen.queryByText('other flyout')).toBeNull();
    expect(flyout()).not.toBeNull();
  });

  it('closes when its tool is taken out while it is open, and does not open again when the tool is registered again', async () => {
    const registry = createToolRegistry();
    const remove = registry.register(flyoutTool('other'));
    const state = createClientState();
    show(state, registry);
    await userEvent.setup().click(tool('other'));
    expect(screen.getByText('other flyout')).not.toBeNull();
    act(() => remove());
    expect(screen.queryByText('other flyout')).toBeNull();
    act(() => {
      registry.register(flyoutTool('other'));
    });
    expect(screen.queryByText('other flyout')).toBeNull();
  });

  it('closes when its tool is taken out and registered again in the same batch', async () => {
    const registry = createToolRegistry();
    const remove = registry.register(flyoutTool('other'));
    const state = createClientState();
    show(state, registry);
    await userEvent.setup().click(tool('other'));
    expect(screen.getByText('other flyout')).not.toBeNull();
    act(() => {
      remove();
      registry.register(flyoutTool('other'));
    });
    expect(screen.queryByText('other flyout')).toBeNull();
  });

  it('does not bring back a flyout that was open for an earlier registration when the strip is drawn after the tool was registered again', () => {
    const registry = createToolRegistry();
    const remove = registry.register(flyoutTool('other'));
    const state = createClientState();
    state.presentation.setOpenTool({ id: 'other', registration: registrationOf(registry, 'other') });
    remove();
    registry.register(flyoutTool('other'));
    show(state, registry);
    expect(screen.queryByText('other flyout')).toBeNull();
  });

  it('does not bring back a flyout when its tool is taken out and registered again while the strip is not drawn', async () => {
    const registry = createToolRegistry();
    const remove = registry.register(flyoutTool('other'));
    const state = createClientState();
    const first = show(state, registry);
    await userEvent.setup().click(tool('other'));
    expect(screen.getByText('other flyout')).not.toBeNull();
    first.unmount();
    remove();
    registry.register(flyoutTool('other'));
    show(state, registry);
    expect(screen.queryByText('other flyout')).toBeNull();
    expect(isActive('other')).toBe(false);
  });

  it('keeps a flyout that is opened while an earlier request names a tool that is not registered', () => {
    const registry = createToolRegistry();
    registry.register(flyoutTool('other'));
    const state = createClientState();
    state.presentation.setOpenTool({ id: 'missing', registration: 1 });
    show(state, registry);
    act(() => state.presentation.setOpenTool({ id: 'other', registration: registrationOf(registry, 'other') }));
    expect(screen.getByText('other flyout')).not.toBeNull();
    expect(state.presentation.view.getState().openTool?.id).toBe('other');
  });

  it('closes when another source is bound, which resets presentation state', async () => {
    const state = createClientState();
    load(state);
    show(state, withExplore());
    await userEvent.setup().click(tool('Explore'));
    expect(flyout()).not.toBeNull();
    act(() => state.bindSource('b'));
    expect(flyout()).toBeNull();
    expect(state.presentation.view.getState().openTool).toBeUndefined();
  });

  it('closes a flyout whose content throws, leaves the strip and its other buttons working', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const registry = withExplore();
    registry.register({
      id: 'broken',
      label: 'broken',
      icon: null,
      order: 20,
      kind: {
        type: 'flyout',
        content: () => {
          throw new Error('cannot draw the flyout');
        },
      },
    });
    const state = createClientState();
    show(state, registry);
    const user = userEvent.setup();
    await user.click(tool('broken'));
    expect(state.presentation.view.getState().openTool).toBeUndefined();
    expect(names()).toEqual(['Explore', 'broken']);
    await user.click(tool('Explore'));
    expect(flyout()).not.toBeNull();
  });

  it('changes the mode without throwing when the renderer cannot start, and the notice stays', async () => {
    const state = createClientState();
    load(state);
    show(state, withExplore(), { failOn: 'mount' });
    const user = userEvent.setup();
    await user.click(tool('Explore'));
    await user.click(row('Pan'));
    expect(state.presentation.view.getState().tool).toBe('pan');
    expect(screen.getByRole('alert').textContent).toBe(RENDERER_UNAVAILABLE);
    expect(flyout()).toBeNull();
  });
});
