import { render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { RouterProvider, createBrowserRouter, createMemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from './api/client.js';
import { fakeClient } from './api/fake-client.js';
import { App } from './app.js';
import { appRoutes } from './routes.js';
import { createClientState } from './state/client-state.js';

const ME = {
  principal: { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', displayName: 'Local user', role: 'administrator' as const },
  edition: 'community' as const,
  identityMode: 'none' as const,
  sources: [],
};

function renderAt(path: string, client: ApiClient) {
  const router = createMemoryRouter(appRoutes(client), { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe('the app', () => {
  it('shows the principal and the edition once /v1/me is read', async () => {
    renderAt('/', fakeClient({ getMe: async () => ({ ok: true, value: ME }) }));
    expect(await screen.findByText('Local user · community')).toBeTruthy();
  });

  it('shows NETWORK_UNAVAILABLE and no principal when the API cannot be reached', async () => {
    renderAt('/', fakeClient({ getMe: async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) }));
    expect((await screen.findByRole('alert')).textContent).toBe('NETWORK_UNAVAILABLE');
    expect(screen.queryByText(/Local user/)).toBeNull();
  });

  it('shows a loading state while the answer is awaited, found by role', () => {
    renderAt('/', fakeClient({ getMe: () => new Promise(() => undefined) }));
    expect(screen.getByRole('status').textContent).toBe('Loading');
    expect(screen.getByRole('heading', { name: 'Neburyx' })).toBeTruthy();
  });
});

describe('the app under StrictMode', () => {
  it('adds no history listener of its own, and leaves only the one the router it was given owns', () => {
    const added: string[] = [];
    const removed: string[] = [];
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    window.addEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      added.push(type);
      add(type, listener, options);
    };
    window.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      removed.push(type);
      remove(type, listener, options);
    };
    try {
      const router = createBrowserRouter(appRoutes(fakeClient({ getMe: () => new Promise(() => undefined) })));
      const afterCreate = added.filter((type) => type === 'popstate').length;
      expect(afterCreate).toBe(1);
      const { unmount } = render(
        <StrictMode>
          <App router={router} state={createClientState()} />
        </StrictMode>,
      );
      expect(added.filter((type) => type === 'popstate')).toHaveLength(afterCreate);
      unmount();
      router.dispose();
      expect(removed.filter((type) => type === 'popstate')).toHaveLength(afterCreate);
    } finally {
      window.addEventListener = add;
      window.removeEventListener = remove;
    }
  });
});
