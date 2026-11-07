import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { ApiClient, ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { clientWith, counted, me, renderApp, source } from '../test-utils.js';
import { IdentityBlock } from './identity-block.js';
import { createShellData, ShellDataProvider, useShellData } from './shell-data.js';
import { SourceLine } from './source-line.js';

const identity = () => screen.getByRole('region', { name: 'Identity' });

describe('the sidebar', () => {
  it('holds the brand, the three links in order and the identity block last, beside the content', async () => {
    renderApp('/', clientWith({ me: me(), sources: [source('a')] }));
    const aside = screen.getByRole('complementary');
    expect(within(aside).getByText('Neburyx')).toBeTruthy();
    expect(within(aside).getAllByRole('link').map((link) => link.textContent)).toEqual(['Home', 'Investigations', 'Sources']);
    const bottom = aside.lastElementChild;
    expect(bottom?.lastElementChild?.getAttribute('aria-label')).toBe('Identity');
    expect(bottom?.firstElementChild?.getAttribute('aria-label')).toBe('Source');
    expect(aside.parentElement?.className).toBe('page-shell');
    expect(screen.getByRole('main')).toBeTruthy();
  });

  it('shows only "Local workspace" in the identity block, with no edition line', async () => {
    renderApp('/', clientWith({ me: me(), sources: [] }));
    expect(await within(identity()).findByText('Local workspace')).toBeTruthy();
    expect(within(identity()).queryByText(/edition/i)).toBeNull();
    expect(identity().querySelectorAll('p')).toHaveLength(1);
  });

  it('shows a loading state while the principal is awaited', () => {
    renderApp('/', fakeClient({ getMe: () => new Promise(() => undefined), getSources: () => new Promise(() => undefined) }));
    expect(within(identity()).getByRole('status').textContent).toBe('Loading');
  });

  it('shows the failure code and the trace ID of a server error, and only the code of a client failure, with the brand and links still there', async () => {
    const server: ApiClient = fakeClient({ getMe: async () => ({ ok: false, failure: { code: 'SOURCE_UNAVAILABLE', message: 'The data source is not available. Try again shortly.', retryable: true, traceId: 'trace-9' } }) });
    const view = renderApp('/', server);
    expect((await within(identity()).findByRole('alert')).textContent).toBe('SOURCE_UNAVAILABLE · trace trace-9');
    expect(screen.getAllByRole('link')).toHaveLength(3);
    view.unmount();
    renderApp('/', fakeClient());
    expect((await within(identity()).findByRole('alert')).textContent).toBe('NETWORK_UNAVAILABLE');
    expect(screen.getByText('Neburyx')).toBeTruthy();
  });

  it('asks for the principal and the sources once, not again when the person moves between pages', async () => {
    const { client, calls } = counted(clientWith({ me: me(), sources: [source('a')] }));
    renderApp('/', client);
    const user = userEvent.setup();
    await screen.findByText('Local workspace');
    await user.click(screen.getByRole('link', { name: 'Sources' }));
    await user.click(screen.getByRole('link', { name: 'Investigations' }));
    await user.click(screen.getByRole('link', { name: 'Home' }));
    expect(calls).toEqual({ me: 1, sources: 1 });
  });

  it('lets Tab reach the three links in order and marks the current page by more than colour', async () => {
    renderApp('/investigations', clientWith({ me: me(), sources: [] }));
    const user = userEvent.setup();
    const seen: string[] = [];
    for (let presses = 0; presses < 3; presses += 1) {
      await user.tab();
      const active = document.activeElement;
      if (active instanceof HTMLAnchorElement) seen.push(active.textContent ?? '');
    }
    expect(seen).toEqual(['Home', 'Investigations', 'Sources']);
    expect(screen.getByRole('link', { name: 'Investigations' }).getAttribute('aria-current')).toBe('page');
  });
});

function Harness({ client, state }: { readonly client: ApiClient; readonly state: ReturnType<typeof createClientState> }) {
  const [store] = useState(() => createShellData(client));
  return (
    <ClientStateProvider state={state}>
      <ShellDataProvider store={store}>
        <Reloader />
        <IdentityBlock />
        <SourceLine />
      </ShellDataProvider>
    </ClientStateProvider>
  );
}

function Reloader() {
  const { reload } = useShellData();
  return <button onClick={reload}>Reload</button>;
}

describe('a later read of the shell data', () => {
  it('keeps the identity and the source line and shows the failure beside them when it fails', async () => {
    let reads = 0;
    const client = fakeClient({
      getMe: async () => (reads++ === 0 ? { ok: true, value: me() } : { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }),
      getSources: async () => ({ ok: true, value: { items: [source('a')], nextCursor: null } }),
    });
    render(<Harness client={client} state={createClientState()} />);
    await screen.findByText('Local workspace');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    expect((await screen.findByRole('alert')).textContent).toBe('NETWORK_UNAVAILABLE');
    expect(screen.getByText('Local workspace')).toBeTruthy();
    expect(screen.getByText(/Source a · read-only · connected/)).toBeTruthy();
  });

  it('shows the newer answer when an older one arrives after it', async () => {
    const pending: Array<(result: ApiResult<ReturnType<typeof me>>) => void> = [];
    const client = fakeClient({ getMe: () => new Promise((resolve) => pending.push(resolve)), getSources: () => new Promise(() => undefined) });
    render(<Harness client={client} state={createClientState()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    expect(pending).toHaveLength(2);
    await act(async () => pending[1]?.({ ok: true, value: me() }));
    await act(async () => pending[0]?.({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }));
    expect(screen.getByText('Local workspace')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the source line and shows the failure beside it when only the sources fail on a later read', async () => {
    let reads = 0;
    const client = fakeClient({
      getMe: async () => ({ ok: true, value: me() }),
      getSources: async () => (reads++ === 0 ? { ok: true, value: { items: [source('a')], nextCursor: null } } : { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }),
    });
    render(<Harness client={client} state={createClientState()} />);
    await screen.findByText(/Source a · read-only · connected/);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    expect((await within(screen.getByRole('region', { name: 'Source' })).findByRole('alert')).textContent).toBe('Unavailable · NETWORK_UNAVAILABLE');
    expect(screen.getByText(/Source a · read-only · connected/)).toBeTruthy();
    expect(screen.getByText('Local workspace')).toBeTruthy();
  });

  it('shows the newer sources answer when an older one arrives after it', async () => {
    const pending: Array<(result: ApiResult<{ items: ReturnType<typeof source>[]; nextCursor: null }>) => void> = [];
    const client = fakeClient({ getMe: async () => ({ ok: true, value: me() }), getSources: () => new Promise((resolve) => pending.push(resolve)) });
    render(<Harness client={client} state={createClientState()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    expect(pending).toHaveLength(2);
    await act(async () => pending[1]?.({ ok: true, value: { items: [source('b', { alias: 'newer' })], nextCursor: null } }));
    await act(async () => pending[0]?.({ ok: true, value: { items: [source('a', { alias: 'older' })], nextCursor: null } }));
    expect(screen.getByText(/newer · read-only/)).toBeTruthy();
    expect(screen.queryByText(/older/)).toBeNull();
  });

  it('shows long unbroken values whole: the sidebar allows them to wrap', async () => {
    const alias = 'a'.repeat(120);
    renderApp('/', clientWith({ me: me(), sources: [source('a', { alias })] }));
    expect((await screen.findAllByText(new RegExp(alias))).length).toBeGreaterThan(0);
  });
});
