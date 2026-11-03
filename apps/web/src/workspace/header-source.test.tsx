import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { createClientState } from '../state/client-state.js';
import { clientWith, counted, me, renderApp, source, WorkspaceHarness } from '../test-utils.js';

const status = () => screen.findByRole('region', { name: 'Source' });
const bar = () => within(screen.getByRole('banner', { name: 'Investigation' }));

describe('the source status in the header', () => {
  it('reads "● alias · read-only · connected" for the one configured source, with the bullet hidden from assistive technology', async () => {
    renderApp('/explore', clientWith({ me: me(), sources: [source('a', { alias: 'fincrime' })] }));
    const region = await status();
    expect(region.textContent).toBe('● fincrime · read-only · connected');
    expect(within(region).getByText('●').getAttribute('aria-hidden')).toBe('true');
  });

  it.each([
    ['degraded', null, 'fincrime · read-only · degraded'],
    ['unavailable', null, 'fincrime · read-only · unavailable'],
    ['unavailable', 'TLS handshake failed', 'fincrime · read-only · unavailable · TLS handshake failed'],
    ['unknown', null, 'fincrime · read-only · unknown'],
  ] as const)('shows the state %s, with the reason only when the source has one', async (state, stateReason, expected) => {
    renderApp('/explore', clientWith({ me: me(), sources: [source('a', { alias: 'fincrime', state, stateReason })] }));
    expect((await status()).textContent).toBe(`● ${expected}`);
  });

  it('reads "N sources · K connected" for several configured sources and none bound', async () => {
    renderApp('/explore', clientWith({ me: me(), sources: [source('a'), source('b', { state: 'unavailable' }), source('c')] }));
    expect((await status()).textContent).toBe('3 sources · 2 connected');
  });

  it('shows the bound source whatever the number of configured sources', async () => {
    const state = createClientState();
    state.bindSource('b');
    renderApp('/explore', clientWith({ me: me(), sources: [source('a', { alias: 'first' }), source('b', { alias: 'second' })] }), state);
    expect((await status()).textContent).toBe('● second · read-only · connected');
  });

  it('shows the id of a bound source that is not in the list, with the state unknown, never connected', async () => {
    const state = createClientState();
    state.bindSource('gone');
    renderApp('/explore', clientWith({ me: me(), sources: [source('a')] }), state);
    expect((await status()).textContent).toBe('● gone · read-only · unknown');
  });

  it('reads "No source connected" for an empty list', async () => {
    renderApp('/explore', clientWith({ me: me(), sources: [] }));
    expect((await status()).textContent).toBe('No source connected');
  });

  it('shows nothing while the first sources read is pending', () => {
    renderApp('/explore', fakeClient({ getMe: async () => ({ ok: true, value: me() }), getSources: () => new Promise(() => undefined) }));
    expect(screen.queryByRole('region', { name: 'Source' })).toBeNull();
  });

  it('shows the status although the principal read is still pending', async () => {
    renderApp('/explore', fakeClient({ getMe: () => new Promise(() => undefined), getSources: async () => ({ ok: true, value: { items: [source('a', { alias: 'fincrime' })], nextCursor: null } }) }));
    expect((await status()).textContent).toBe('● fincrime · read-only · connected');
  });

  it('shows the status although the principal read has failed, and the strip names that failure', async () => {
    renderApp('/explore', fakeClient({ getSources: async () => ({ ok: true, value: { items: [source('a', { alias: 'fincrime' })], nextCursor: null } }) }));
    expect((await status()).textContent).toBe('● fincrime · read-only · connected');
    expect(screen.getByRole('alert').textContent).toBe('NETWORK_UNAVAILABLE');
  });
});

describe('the Synthetic data badge in the header', () => {
  it.each([
    ['one synthetic source', [source('a', { synthetic: true })], null, true],
    ['one real source', [source('a', { synthetic: false })], null, false],
    ['a bound synthetic source beside a real one', [source('a', { synthetic: false }), source('b', { synthetic: true })], 'b', true],
    ['a bound real source beside a synthetic one', [source('a', { synthetic: true }), source('b', { synthetic: false })], 'b', false],
    ['several sources, none bound, all synthetic', [source('a'), source('b')], null, true],
    ['several sources, none bound, a mix', [source('a'), source('b', { synthetic: false })], null, false],
    ['an empty list', [], null, false],
    ['a bound source missing from the list', [source('a')], 'gone', false],
  ] as const)('for %s shows the badge: %s', async (_name, sources, bound, shown) => {
    const state = createClientState();
    if (bound !== null) state.bindSource(bound);
    renderApp('/explore', clientWith({ me: me(), sources: [...sources] }), state);
    await status();
    expect(bar().queryByText('Synthetic data') !== null).toBe(shown);
  });
});

describe('a later read of the sources', () => {
  it('keeps the status and the badge and names the failure in the strip when a refresh fails', async () => {
    let reads = 0;
    const client = fakeClient({
      getMe: async () => ({ ok: true, value: me() }),
      getSources: async () => (reads++ === 0 ? { ok: true, value: { items: [source('a', { alias: 'fincrime' })], nextCursor: null } } : { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }),
    });
    render(<WorkspaceHarness client={client} />);
    await status();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    expect((await screen.findByRole('alert')).textContent).toBe('NETWORK_UNAVAILABLE');
    expect((await status()).textContent).toBe('● fincrime · read-only · connected');
    expect(bar().getByText('Synthetic data')).toBeTruthy();
  });

  it('shows the newer answer when an older one arrives after it', async () => {
    const pending: Array<(result: ApiResult<{ items: ReturnType<typeof source>[]; nextCursor: null }>) => void> = [];
    const client = fakeClient({ getMe: async () => ({ ok: true, value: me() }), getSources: () => new Promise((resolve) => pending.push(resolve)) });
    render(<WorkspaceHarness client={client} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    await act(async () => pending[1]?.({ ok: true, value: { items: [source('b', { alias: 'newer' })], nextCursor: null } }));
    await act(async () => pending[0]?.({ ok: true, value: { items: [source('a', { alias: 'older' })], nextCursor: null } }));
    expect((await status()).textContent).toBe('● newer · read-only · connected');
  });

  it('asks for the sources once for the whole app', async () => {
    const { client, calls } = counted(clientWith({ me: me(), sources: [source('a')] }));
    renderApp('/explore', client);
    await screen.findByText(/read-only · connected/);
    expect(calls.sources).toBe(1);
    expect(calls.me).toBe(1);
  });
});
