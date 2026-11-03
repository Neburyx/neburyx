import { render } from '@testing-library/react';
import { useMemo } from 'react';
import type { MeResponse, SourceSummary } from '@neburyx/contracts';
import { MemoryRouter, RouterProvider, createMemoryRouter } from 'react-router';
import type { ApiClient } from './api/client.js';
import { fakeClient } from './api/fake-client.js';
import { appRoutes } from './routes.js';
import { createShellData, ShellDataProvider, useShellData } from './shell/shell-data.js';
import { createClientState, type ClientState } from './state/client-state.js';
import { ClientStateProvider } from './state/context.js';
import { createSlotRegistry, SlotsProvider, type SlotRegistry } from './workspace/slots.js';
import { WorkspaceShell } from './workspace/workspace-shell.js';

export function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return { principal: { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', displayName: 'Local user', role: 'administrator' }, edition: 'community', identityMode: 'none', sources: [], ...overrides };
}

export function source(id: string, overrides: Partial<SourceSummary> = {}): SourceSummary {
  return { id, alias: `Source ${id}`, state: 'connected', stateReason: null, readOnly: true, synthetic: true, lastTestAt: null, mappingSummary: { entityTypes: 1, relationshipTypes: 1, derivedRules: 0 }, ...overrides };
}

export function clientWith(parts: { readonly me?: MeResponse; readonly sources?: readonly SourceSummary[] }): ApiClient {
  return fakeClient({
    getMe: async () => (parts.me === undefined ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : { ok: true, value: parts.me }),
    getSources: async () => (parts.sources === undefined ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : { ok: true, value: { items: [...parts.sources], nextCursor: null } }),
  });
}

export interface Counted {
  readonly client: ApiClient;
  readonly calls: { me: number; sources: number };
}

export function counted(client: ApiClient): Counted {
  const calls = { me: 0, sources: 0 };
  return {
    calls,
    client: {
      ...client,
      getMe: (signal) => {
        calls.me += 1;
        return client.getMe(signal);
      },
      getSources: (signal) => {
        calls.sources += 1;
        return client.getSources(signal);
      },
    },
  };
}

export function renderApp(path: string, client: ApiClient, state: ClientState = createClientState(), slots: SlotRegistry = createSlotRegistry()): { readonly router: ReturnType<typeof createMemoryRouter>; readonly state: ClientState; readonly slots: SlotRegistry; readonly container: HTMLElement; readonly unmount: () => void } {
  const router = createMemoryRouter(appRoutes(client), { initialEntries: [path] });
  const view = render(
    <ClientStateProvider state={state}>
      <SlotsProvider registry={slots}>
        <RouterProvider router={router} />
      </SlotsProvider>
    </ClientStateProvider>,
  );
  return { router, state, slots, container: view.container, unmount: view.unmount };
}

function Reloader() {
  const { reload } = useShellData();
  return <button onClick={reload}>Reload</button>;
}

/** The workspace shell with a button that reads the shell data again, for tests of a later read. */
export function WorkspaceHarness({ client, state = createClientState() }: { readonly client: ApiClient; readonly state?: ClientState }) {
  const store = useMemo(() => createShellData(client), [client]);
  const slots = useMemo(() => createSlotRegistry(), []);
  return (
    <ClientStateProvider state={state}>
      <SlotsProvider registry={slots}>
        <ShellDataProvider store={store}>
          <MemoryRouter initialEntries={['/explore']}>
            <Reloader />
            <WorkspaceShell />
          </MemoryRouter>
        </ShellDataProvider>
      </SlotsProvider>
    </ClientStateProvider>
  );
}
