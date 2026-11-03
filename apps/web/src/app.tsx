import { RouterProvider, type createBrowserRouter } from 'react-router';
import type { ClientState } from './state/client-state.js';
import { ClientStateProvider } from './state/context.js';
import { RendererProvider } from './canvas/renderer-context.js';
import type { CreateRenderer } from './canvas/scene.js';
import { SlotsProvider, type SlotRegistry } from './workspace/slots.js';

export interface AppProps {
  readonly router: ReturnType<typeof createBrowserRouter>;
  readonly state: ClientState;
  readonly slots: SlotRegistry;
  readonly createRenderer: CreateRenderer;
}

/** The router and the state are made once, outside React, so rendering twice (StrictMode) never makes a second router. */
export function App({ router, state, slots, createRenderer }: AppProps) {
  return (
    <ClientStateProvider state={state}>
      <SlotsProvider registry={slots}>
        <RendererProvider createRenderer={createRenderer}>
          <RouterProvider router={router} />
        </RendererProvider>
      </SlotsProvider>
    </ClientStateProvider>
  );
}
