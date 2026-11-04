import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { createBrowserRouter, createMemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { fakeClient } from './api/fake-client.js';
import { App } from './app.js';
import { appRoutes } from './routes.js';
import { createClientState } from './state/client-state.js';
import { createSelectionActionRegistry } from './workspace/selection-actions.js';
import { createSlotRegistry } from './workspace/slots.js';
import { createToolRegistry } from './workspace/tool-registry.js';
import { clientWith, counted, me, source, stubFactory } from './test-utils.js';

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
      const state = createClientState();
      const router = createBrowserRouter(appRoutes(fakeClient({ getMe: () => new Promise(() => undefined) }), state));
      const afterCreate = added.filter((type) => type === 'popstate').length;
      expect(afterCreate).toBe(1);
      const { unmount } = render(
        <StrictMode>
          <App router={router} state={state} slots={createSlotRegistry()} selectionActions={createSelectionActionRegistry()} tools={createToolRegistry()} createRenderer={stubFactory().create} />
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

  it('asks for the principal and the sources once when the app starts, and not again when the person moves between pages', async () => {
    const { client, calls } = counted(clientWith({ me: me(), sources: [source('a')] }));
    const state = createClientState();
    const router = createMemoryRouter(appRoutes(client, state), { initialEntries: ['/'] });
    render(
      <StrictMode>
        <App router={router} state={state} slots={createSlotRegistry()} selectionActions={createSelectionActionRegistry()} tools={createToolRegistry()} createRenderer={stubFactory().create} />
      </StrictMode>,
    );
    await screen.findByText('Local workspace');
    await userEvent.setup().click(screen.getByRole('link', { name: 'Sources' }));
    await screen.findByRole('heading', { name: 'Sources' });
    expect(calls).toEqual({ me: 1, sources: 1 });
  });
});
