import { RouterProvider, type createBrowserRouter } from 'react-router';
import type { ClientState } from './state/client-state.js';
import { ClientStateProvider } from './state/context.js';
import { SlotsProvider, type SlotRegistry } from './workspace/slots.js';

export interface AppProps {
  readonly router: ReturnType<typeof createBrowserRouter>;
  readonly state: ClientState;
  readonly slots: SlotRegistry;
}

/** The router and the state are made once, outside React, so rendering twice (StrictMode) never makes a second router. */
export function App({ router, state, slots }: AppProps) {
  return (
    <ClientStateProvider state={state}>
      <SlotsProvider registry={slots}>
        <RouterProvider router={router} />
      </SlotsProvider>
    </ClientStateProvider>
  );
}
