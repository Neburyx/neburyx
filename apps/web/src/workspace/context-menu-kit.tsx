import { act, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi, type Mock } from 'vitest';
import { GraphCanvas } from '../canvas/graph-canvas.js';
import { ProfileProvider } from '../canvas/profile-context.js';
import { RendererProvider } from '../canvas/renderer-context.js';
import type { RightClick } from '../canvas/scene.js';
import { testProfile } from '../dev/test-profile.js';
import { ShellDataProvider } from '../shell/shell-data.js';
import type { ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import type { GraphEdge, GraphNode } from '@neburyx/contracts';
import { elementKey } from '../state/keys.js';
import { key, ref, result } from '../state/test-data.js';
import { builtInKeyBindings, staticProfile, staticShell, stubFactory, type StubOptions } from '../test-utils.js';
import { registerBuiltInMenuItems } from './built-in-menu-items.js';
import { ContextMenu } from './context-menu.js';
import { KeyBindingsProvider } from './key-binding-registry.js';
import { createMenuRegistry, MenuProvider, type MenuContext, type MenuItem, type MenuItemState, type MenuRegistry } from './menu-registry.js';
import { ZoomControls } from './zoom-controls.js';

export const ids = ['n1', 'n2', 'n3'];
export const nodeKey = (id: string): string => elementKey(ref('a', 'type-a', id));

export function load(state: ClientState, nodeIds: readonly string[] = ids): void {
  state.bindSource('a');
  state.putResult(key('a'), result('a', [...nodeIds], []));
  state.setLoaded([key('a')], nodeIds.map((id) => ref('a', 'type-a', id)), []);
}

export interface Shown {
  readonly factory: ReturnType<typeof stubFactory>;
  readonly outside: Mock<() => void>;
  readonly rightClick: (request: RightClick) => void;
}

export function show(state: ClientState, options: StubOptions = {}, menus: MenuRegistry = withBuiltIns(), edition: 'community' | 'enterprise' | undefined = 'community', extra: ReactNode = null): Shown {
  const factory = stubFactory(options);
  const outside = vi.fn<() => void>();
  render(
    <ClientStateProvider state={state}>
      <ShellDataProvider store={staticShell(edition)}>
        <MenuProvider registry={menus}>
          <KeyBindingsProvider registry={builtInKeyBindings()}>
            <ProfileProvider store={staticProfile('a', testProfile('a', ['type-a']))}>
              <RendererProvider createRenderer={factory.create}>
                <GraphCanvas />
                <ZoomControls />
                <ContextMenu />
                {extra}
                <button type="button" onClick={outside}>
                  Outside
                </button>
              </RendererProvider>
            </ProfileProvider>
          </KeyBindingsProvider>
        </MenuProvider>
      </ShellDataProvider>
    </ClientStateProvider>,
  );
  const rightClick = (request: RightClick): void => {
    const events = factory.made[0]?.events[0];
    if (events === undefined) throw new Error('the renderer was not mounted');
    act(() => events.contextMenu(request));
  };
  return { factory, outside, rightClick };
}

export function loadGraph(state: ClientState, nodes: readonly GraphNode[], edges: readonly GraphEdge[]): void {
  state.bindSource('a');
  state.putResult(key('a'), { sourceId: 'a', nodes: [...nodes], edges: [...edges] });
  state.setLoaded([key('a')], nodes.map((candidate) => candidate.ref), edges.map((candidate) => candidate.ref));
}

export function withBuiltIns(): MenuRegistry {
  const registry = createMenuRegistry();
  registerBuiltInMenuItems(registry);
  return registry;
}

export const onCanvas = (x: number, y: number): RightClick => ({ target: undefined, x, y });
export const menu = (): HTMLElement => screen.getByRole('menu', { name: 'Canvas' });
export const item = (name: string): HTMLElement => within(menu()).getByRole('menuitem', { name });
export const selection = (state: ClientState): string[] => [...state.presentation.view.getState().selection].sort();
export const placeOf = (): { readonly left: string; readonly top: string } => {
  const holder = screen.getByRole('menu').parentElement;
  if (holder === null) throw new Error('the menu has no holder');
  return { left: holder.style.left, top: holder.style.top };
};

export interface CommandOptions {
  readonly group?: number;
  readonly order?: number;
  readonly state?: MenuItemState;
  readonly lock?: boolean;
  readonly run?: (context: MenuContext) => void;
}

/** An item that runs a command, named by its ID; what is not given is the default of a plain enabled item. */
export function commandItem(id: string, options: CommandOptions = {}): MenuItem {
  const { group = 10, order = 10, state, lock, run = () => undefined } = options;
  return { id, label: id, icon: null, group, order, run, ...(state === undefined ? {} : { state }), ...(lock === undefined ? {} : { lock }) };
}
