import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fakeClient } from '../api/fake-client.js';
import { createClientState } from '../state/client-state.js';
import { clientWith, counted, me, renderApp, source } from '../test-utils.js';

const line = () => screen.getByRole('region', { name: 'Source' });

describe('the source status line', () => {
  it('shows "alias · read-only" and the state in words for the only configured source', async () => {
    renderApp('/', clientWith({ me: me(), sources: [source('a', { alias: 'banking' })] }));
    expect(await within(line()).findByText(/banking · read-only · connected/)).toBeTruthy();
  });

  it('shows the number of sources and how many are connected when there are several and none is bound', async () => {
    renderApp('/', clientWith({ me: me(), sources: [source('a'), source('b', { state: 'unavailable' }), source('c', { state: 'degraded' })] }));
    expect(await within(line()).findByText('3 sources · 1 connected')).toBeTruthy();
  });

  it('shows the bound source whatever the number of sources', async () => {
    const state = createClientState();
    state.bindSource('b');
    renderApp('/', clientWith({ me: me(), sources: [source('a'), source('b', { alias: 'claims' })] }), state);
    expect(await within(line()).findByText(/claims · read-only · connected/)).toBeTruthy();
  });

  it('shows the id of a bound source that is not in the list, with the state unknown and never connected', async () => {
    const state = createClientState();
    state.bindSource('gone');
    renderApp('/', clientWith({ me: me(), sources: [source('a')] }), state);
    expect(await within(line()).findByText(/gone · read-only · unknown/)).toBeTruthy();
    expect(within(line()).queryByText(/connected/)).toBeNull();
  });

  it.each([
    ['unavailable', 'TLS handshake failed', 'Source a · read-only · unavailable · TLS handshake failed'],
    ['unavailable', null, 'Source a · read-only · unavailable'],
    ['degraded', 'estimated degree counts', 'Source a · read-only · degraded · estimated degree counts'],
    ['degraded', null, 'Source a · read-only · degraded'],
  ] as const)('shows a %s source with the reason %s', async (state, reason, text) => {
    renderApp('/', clientWith({ me: me(), sources: [source('a', { state, stateReason: reason })] }));
    expect(await within(line()).findByText((_content, element) => element?.tagName === 'P' && element.textContent === `● ${text}`)).toBeTruthy();
  });

  it('shows a loading state while the sources are awaited', () => {
    renderApp('/', fakeClient({ getMe: async () => ({ ok: true, value: me() }), getSources: () => new Promise(() => undefined) }));
    expect(within(line()).getByRole('status').textContent).toBe('Loading');
  });

  it('says "No source connected" for an empty list', async () => {
    renderApp('/', clientWith({ me: me(), sources: [] }));
    expect(await within(line()).findByText('No source connected')).toBeTruthy();
  });

  it('shows an explicit Unavailable state with the code when the API cannot be reached, and the sidebar and the navigation stay', async () => {
    renderApp('/', clientWith({ me: me() }));
    expect((await within(line()).findByRole('alert')).textContent).toBe('Unavailable · NETWORK_UNAVAILABLE');
    expect(screen.getAllByRole('link')).toHaveLength(3);
    expect(screen.getByText('Local workspace')).toBeTruthy();
  });

  it('shows the code and the trace ID of a server error', async () => {
    renderApp('/', fakeClient({ getMe: async () => ({ ok: true, value: me() }), getSources: async () => ({ ok: false, failure: { code: 'ACCESS_DENIED', message: 'You do not have access to this.', retryable: false, traceId: 'trace-3' } }) }));
    expect((await within(line()).findByRole('alert')).textContent).toBe('ACCESS_DENIED · trace trace-3');
  });

  it('is read once for the whole shell: the same answer feeds the line and, across navigation, no second request is made', async () => {
    const { client, calls } = counted(clientWith({ me: me(), sources: [source('a'), source('b')] }));
    renderApp('/', client);
    await within(line()).findByText('2 sources · 2 connected');
    expect(calls.sources).toBe(1);
  });
});
