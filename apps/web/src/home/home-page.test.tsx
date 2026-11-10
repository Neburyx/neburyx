import { act, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { failsThenWaits, INVESTIGATION_A, INVESTIGATION_B, investigationOf, knowing, listItemOf, nodeOf, listOf, REAL_SOURCE } from '../investigations/test-data.js';
import type { ApiClient } from '../api/client.js';
import { createClientState } from '../state/client-state.js';
import { renderApp, source } from '../test-utils.js';

beforeAll(() => configure({ reactStrictMode: true }));
afterAll(() => configure({ reactStrictMode: false }));

const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1', { createdAt: '2026-11-05T10:00:00.000Z', lastEditedAt: '2026-11-05T10:05:00.000Z' }), node: nodeOf('source-a', 'kind-a', 'A-1') };
const B = { investigation: investigationOf(INVESTIGATION_B, 'source-b', 'kind-a', 'C-1', { createdAt: '2026-11-05T10:10:00.000Z', lastEditedAt: '2026-11-05T10:15:00.000Z' }), node: nodeOf('source-b', 'kind-a', 'C-1') };

const header = () => document.querySelector('.page-heading');
const rowsOf = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.recent-row')];

describe('Home: the Recent list', () => {
  it('lists the investigations of two sources with their own sources, in the order the list answers, from one read of the list with the documented query', async () => {
    const asked: number[] = [];
    const parts = knowing([B, A], { listInvestigations: async (limit) => (asked.push(limit), { ok: true, value: listOf([listItemOf(B.investigation), listItemOf(A.investigation)]) }) });
    renderApp('/', parts.client);
    await screen.findByRole('link', { name: 'kind-a C-1' });
    const rows = rowsOf();
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining('kind-a C-1'), expect.stringContaining('kind-a A-1')]);
    expect(rows[0]?.textContent).toContain('Source source-b');
    expect(rows[1]?.textContent).toContain('Source source-a');
    expect(asked).toEqual([5]);
  });

  it('links the Recent list to the Investigations page with View all', async () => {
    renderApp('/', knowing([A, B]).client);
    await screen.findByRole('link', { name: 'kind-a A-1' });
    expect(screen.getByRole('link', { name: 'View all' }).getAttribute('href')).toBe('/investigations');
  });

  it('sends the list, the sources and the identity and nothing else when Home is opened', async () => {
    const parts = knowing([A, B]);
    renderApp('/', parts.client);
    await screen.findByRole('link', { name: 'kind-a A-1' });
    expect(parts.calls).toEqual({ getEntity: [], getInvestigation: [], openInvestigation: [], listInvestigations: [5] });
  });

  it('names the source in the heading with one source configured and none with several', async () => {
    const one = knowing([A], { getSources: async () => ({ ok: true, value: { items: [source('source-a')], nextCursor: null } }) });
    const first = renderApp('/', one.client);
    await screen.findByRole('link', { name: 'kind-a A-1' });
    expect(header()?.querySelector('.source-note')?.textContent).toContain('Source source-a · read-only');
    first.unmount();
    renderApp('/', knowing([A, B]).client);
    await screen.findByRole('link', { name: 'kind-a A-1' });
    expect(header()?.querySelector('.source-note')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Investigations', level: 1 })).toBeTruthy();
  });

  it('says it is loading while the list is read', async () => {
    renderApp('/', knowing([A], failsThenWaits()).client);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Try again' }));
    expect((await screen.findByRole('status')).textContent).toBe('Loading recent investigations…');
  });

  it('shows the failure with its code and reads the list again on Try again, keeping the rest of Home', async () => {
    let attempts = 0;
    const parts = knowing([A], {
      listInvestigations: async () => {
        attempts += 1;
        return attempts === 1 ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : { ok: true, value: listOf([listItemOf(A.investigation)]) };
      },
    });
    renderApp('/', parts.client);
    expect((await screen.findByRole('alert')).textContent).toContain('NETWORK_UNAVAILABLE');
    expect(screen.getByRole('heading', { name: 'Recent', level: 2 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Investigations', level: 1 })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'kind-a A-1' })).toBeTruthy();
    expect(attempts).toBe(2);
  });

  it('shows the empty state in Recent\'s place when the list is empty', async () => {
    renderApp('/', knowing([], REAL_SOURCE).client);
    expect(await screen.findByRole('heading', { name: 'No investigations yet', level: 3 })).toBeTruthy();
    expect(screen.queryByText(/starting entity/)).toBeNull();
    expect(rowsOf()).toHaveLength(0);
  });

  it.each([
    ['a real source that is connected', REAL_SOURCE],
    ['a failed sources read', { getSources: async () => ({ ok: false as const, failure: { code: 'NETWORK_UNAVAILABLE' as const } }) }],
  ])('never offers Connect your Neo4j or says no source is connected on Home with an empty list and %s', async (_name, overrides) => {
    renderApp('/', knowing([], overrides).client);
    await screen.findByRole('heading', { name: 'No investigations yet', level: 3 });
    const main = within(screen.getByRole('main'));
    expect(main.queryByText(/No source connected/i)).toBeNull();
    expect(main.queryByText(/Connect your/i)).toBeNull();
    expect(main.queryByRole('button', { name: /Connect your Neo4j/ })).toBeNull();
  });

  it('shows five rows and says so when the list holds more', async () => {
    const many = Array.from({ length: 6 }, (_unused, index) => ({ investigation: investigationOf(`0192f000-0000-7000-8000-00000000010${index}`, 'source-a', 'kind-a', `M-${index}`), node: nodeOf('source-a', 'kind-a', `M-${index}`) }));
    renderApp('/', knowing(many).client);
    await screen.findByRole('link', { name: 'kind-a M-0' });
    expect(rowsOf()).toHaveLength(5);
    expect(screen.getByText('Showing the 5 most recent.')).toBeTruthy();
  });

  it('shows no note when the list holds no more than the rows shown', async () => {
    renderApp('/', knowing([A, B]).client);
    await screen.findByRole('link', { name: 'kind-a A-1' });
    expect(screen.queryByText('Showing the 5 most recent.')).toBeNull();
  });

  it('names the one configured source in the heading even when the session is bound to a source that is not configured', async () => {
    const state = createClientState();
    state.bindSource('retired');
    renderApp('/', knowing([A], { getSources: async () => ({ ok: true, value: { items: [source('source-a', { alias: 'Books', synthetic: false })], nextCursor: null } }) }).client, state);
    await screen.findByRole('link', { name: 'kind-a A-1' });
    expect(header()?.querySelector('.source-note')?.textContent).toContain('Books · read-only');
    expect(screen.queryByText('Synthetic data')).toBeNull();
  });
});

describe('Home: a visit after the first', () => {
  const visit = async (view: ReturnType<typeof renderApp>, to: string) => act(async () => view.router.navigate(to));

  it('shows that the list is being read while the earlier rows stay, and then the new rows', async () => {
    let release: (value: Awaited<ReturnType<ApiClient['listInvestigations']>>) => void = () => undefined;
    let reads = 0;
    const parts = knowing([A], {
      listInvestigations: (_limit: number) => (++reads === 1 ? Promise.resolve({ ok: true as const, value: listOf([listItemOf(A.investigation)]) }) : new Promise((resolve) => (release = resolve))),
    });
    const view = renderApp('/', parts.client);
    await screen.findByRole('link', { name: 'kind-a A-1' });
    expect(screen.queryByText('Loading recent investigations…')).toBeNull();
    await visit(view, '/sources');
    await visit(view, '/');
    expect(await screen.findByText('Loading recent investigations…')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'kind-a A-1' })).toBeTruthy();
    await act(async () => release({ ok: true, value: listOf([listItemOf(B.investigation), listItemOf(A.investigation)]) }));
    await screen.findByRole('link', { name: 'kind-a C-1' });
    expect(screen.queryByText('Loading recent investigations…')).toBeNull();
    expect(rowsOf()).toHaveLength(2);
  });

  it('keeps the earlier rows and shows the failure when the new read fails, and reads again on Try again', async () => {
    let reads = 0;
    const parts = knowing([A], {
      listInvestigations: async () => (++reads === 2 ? { ok: false as const, failure: { code: 'NETWORK_UNAVAILABLE' } } : { ok: true as const, value: listOf([listItemOf(A.investigation)]) }),
    });
    const view = renderApp('/', parts.client);
    await screen.findByRole('link', { name: 'kind-a A-1' });
    await visit(view, '/sources');
    await visit(view, '/');
    expect((await screen.findByRole('alert')).textContent).toContain('NETWORK_UNAVAILABLE');
    expect(screen.getByRole('link', { name: 'kind-a A-1' })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByRole('link', { name: 'kind-a A-1' })).toBeTruthy();
    expect(reads).toBe(3);
  });
});

