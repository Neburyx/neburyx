import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ApiClient, ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { clientWith, me, renderApp, source, WorkspaceHarness } from '../test-utils.js';

const rail = () => screen.getByRole('navigation', { name: 'Workspace' });

describe('Explore in the workspace shell', () => {
  it('shows the rail, the header and the canvas region, and neither the page sidebar nor a page heading', async () => {
    renderApp('/explore', clientWith({ me: me(), sources: [source('a')] }));
    expect(await screen.findByText('Local workspace')).toBeTruthy();
    expect(rail()).toBeTruthy();
    expect(screen.getByRole('banner', { name: 'Investigation' })).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('holds one destination for each of Home, Investigations and Sources, in order, each going to its page', () => {
    renderApp('/explore', clientWith({ me: me(), sources: [] }));
    const links = within(rail()).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('aria-label'))).toEqual(['Home', 'Investigations', 'Sources']);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/', '/investigations', '/sources']);
  });

  it('marks Investigations as the current destination on Explore, and no other', () => {
    renderApp('/explore', clientWith({ me: me(), sources: [] }));
    expect(within(rail()).getByRole('link', { name: 'Investigations' }).getAttribute('aria-current')).toBe('location');
    expect(within(rail()).getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBeNull();
    expect(within(rail()).getByRole('link', { name: 'Sources' }).getAttribute('aria-current')).toBeNull();
  });

  it('moves to a page with Enter on a destination reached by Tab, in order, with no stop on the brand mark', async () => {
    const { router } = renderApp('/explore', clientWith({ me: me(), sources: [] }));
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(within(rail()).getByRole('link', { name: 'Home' }));
    await user.tab();
    expect(document.activeElement).toBe(within(rail()).getByRole('link', { name: 'Investigations' }));
    await user.tab();
    expect(document.activeElement).toBe(within(rail()).getByRole('link', { name: 'Sources' }));
    await user.keyboard('{Enter}');
    expect(router.state.location.pathname).toBe('/sources');
  });
});

describe('the rail identity', () => {
  it('shows the caption "Local workspace" for Community', async () => {
    renderApp('/explore', clientWith({ me: me(), sources: [] }));
    expect(await screen.findByText('Local workspace')).toBeTruthy();
  });
});

type Reply<T> = (result: ApiResult<T>) => void;

function controlled() {
  const principal: Array<Reply<ReturnType<typeof me>>> = [];
  const sources: Array<Reply<{ items: ReturnType<typeof source>[]; nextCursor: null }>> = [];
  const client: ApiClient = fakeClient({
    getMe: () => new Promise((resolve) => principal.push(resolve)),
    getSources: () => new Promise((resolve) => sources.push(resolve)),
  });
  return { client, principal, sources };
}

const serverFailure = (traceId: string): ApiResult<never> => ({ ok: false, failure: { code: 'SOURCE_UNAVAILABLE', message: 'unavailable', retryable: true, traceId } });
const networkFailure: ApiResult<never> = { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } };

describe('the shell reads on Explore, each on its own', () => {
  it('shows no caption while the first principal read is pending, and the destinations at once', () => {
    const { client } = controlled();
    renderApp('/explore', client);
    expect(within(rail()).getAllByRole('link')).toHaveLength(3);
    expect(screen.queryByText('Local workspace')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Notices' })).toBeNull();
  });

  it('names the code and the trace ID in a strip under the header when the first principal read fails, and keeps the destinations', async () => {
    const { client, principal } = controlled();
    renderApp('/explore', client);
    await act(async () => principal[0]?.(serverFailure('trace-1')));
    const strip = screen.getByRole('group', { name: 'Notices' });
    expect(within(strip).getByRole('alert').textContent).toBe('SOURCE_UNAVAILABLE · trace trace-1');
    expect(within(rail()).getAllByRole('link')).toHaveLength(3);
    expect(strip.previousElementSibling?.getAttribute('aria-label')).toBe('Investigation');
  });

  it('names a failure without a trace ID by its code alone', async () => {
    const { client, principal } = controlled();
    renderApp('/explore', client);
    await act(async () => principal[0]?.(networkFailure));
    expect(screen.getByRole('alert').textContent).toBe('NETWORK_UNAVAILABLE');
  });

  it('keeps the caption while the sources read is pending, and shows the sources failure with its trace ID independently of the principal', async () => {
    const { client, principal, sources } = controlled();
    renderApp('/explore', client);
    await act(async () => principal[0]?.({ ok: true, value: me() }));
    expect(screen.getByText('Local workspace')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Notices' })).toBeNull();
    await act(async () => sources[0]?.(serverFailure('trace-2')));
    expect(screen.getByRole('alert').textContent).toBe('SOURCE_UNAVAILABLE · trace trace-2');
    expect(screen.getByText('Local workspace')).toBeTruthy();
  });
});

describe('a later read after an answer', () => {
  it('keeps the caption through a pending refresh of the principal, and through its failure, and names the failure in the strip', async () => {
    const replies: Array<(result: ApiResult<ReturnType<typeof me>>) => void> = [];
    let reads = 0;
    const client = fakeClient({
      getMe: () => (reads++ === 0 ? Promise.resolve({ ok: true, value: me() }) : new Promise((resolve) => replies.push(resolve))),
      getSources: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
    });
    render(<WorkspaceHarness client={client} />);
    await screen.findByText('Local workspace');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    expect(screen.getByText('Local workspace')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => replies[0]?.(serverFailure('trace-3')));
    expect(screen.getByText('Local workspace')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Notices' })).getByRole('alert').textContent).toBe('SOURCE_UNAVAILABLE · trace trace-3');
  });

  it('keeps the caption and names the failure when only the sources fail on a later read', async () => {
    let reads = 0;
    const client = fakeClient({
      getMe: async () => ({ ok: true, value: me() }),
      getSources: async () => (reads++ === 0 ? { ok: true, value: { items: [source('a')], nextCursor: null } } : networkFailure),
    });
    render(<WorkspaceHarness client={client} />);
    await screen.findByText('Local workspace');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    expect((await screen.findByRole('alert')).textContent).toBe('NETWORK_UNAVAILABLE');
    expect(screen.getByText('Local workspace')).toBeTruthy();
  });

  it('shows no strip when a later read succeeds after a first failure', async () => {
    let reads = 0;
    const client = fakeClient({
      getMe: async () => (reads++ === 0 ? networkFailure : { ok: true, value: me() }),
      getSources: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
    });
    render(<WorkspaceHarness client={client} />);
    await screen.findByRole('alert');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByText('Local workspace')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
