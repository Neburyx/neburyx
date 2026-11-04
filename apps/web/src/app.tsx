import { RouterProvider, type createBrowserRouter } from 'react-router';
import type { ClientState } from './state/client-state.js';
import { ClientStateProvider } from './state/context.js';
import { RendererProvider } from './canvas/renderer-context.js';
import type { CreateRenderer } from './canvas/scene.js';
import { PanelsProvider, type PanelRegistry } from './workspace/panel-registry.js';
import { MenuProvider, type MenuRegistry } from './workspace/menu-registry.js';
import { SelectionActionsProvider, type SelectionActionRegistry } from './workspace/selection-actions.js';
import { SlotsProvider, type SlotRegistry } from './workspace/slots.js';
import { ToolsProvider, type ToolRegistry } from './workspace/tool-registry.js';

export interface AppProps {
  readonly router: ReturnType<typeof createBrowserRouter>;
  readonly state: ClientState;
  readonly slots: SlotRegistry;
  readonly selectionActions: SelectionActionRegistry;
  readonly tools: ToolRegistry;
  readonly menus: MenuRegistry;
  readonly panels: PanelRegistry;
  readonly createRenderer: CreateRenderer;
}

/** The router and the state are made once, outside React, so rendering twice (StrictMode) never makes a second router. */
export function App({ router, state, slots, selectionActions, tools, menus, panels, createRenderer }: AppProps) {
  return (
    <ClientStateProvider state={state}>
      <SlotsProvider registry={slots}>
        <SelectionActionsProvider registry={selectionActions}>
          <ToolsProvider registry={tools}>
            <MenuProvider registry={menus}>
              <PanelsProvider registry={panels}>
                <RendererProvider createRenderer={createRenderer}>
                  <RouterProvider router={router} />
                </RendererProvider>
              </PanelsProvider>
            </MenuProvider>
          </ToolsProvider>
        </SelectionActionsProvider>
      </SlotsProvider>
    </ClientStateProvider>
  );
}
