import { RouterProvider, type createBrowserRouter } from 'react-router';
import type { ClientState } from './state/client-state.js';
import { ClientStateProvider } from './state/context.js';

export interface AppProps {
  readonly router: ReturnType<typeof createBrowserRouter>;
  readonly state: ClientState;
}

/** The router and the state are made once, outside React, so rendering twice (StrictMode) never makes a second router. */
export function App({ router, state }: AppProps) {
  return (
    <ClientStateProvider state={state}>
      <RouterProvider router={router} />
    </ClientStateProvider>
  );
}
