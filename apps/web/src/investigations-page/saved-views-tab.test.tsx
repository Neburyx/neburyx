import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { renderApp } from '../test-utils.js';
import { pagedClient, rowsOf, viewsOf } from './page-fixtures.js';

beforeAll(() => configure({ reactStrictMode: true }));
afterAll(() => configure({ reactStrictMode: false }));

const bodyRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.investigations-table tbody tr')];

describe('the Saved views tab', () => {
  it('lists the views with their columns, the exact count in the tab and the corrected footnote', async () => {
    const { client } = pagedClient(rowsOf(3), viewsOf(3));
    renderApp('/investigations?tab=views', client);
    await screen.findByRole('button', { name: /Open “View 1”/ });
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['View name', 'Investigation', 'Source', 'Saved by', 'Saved at (UTC)', 'Open']);
    expect(bodyRows()).toHaveLength(3);
    expect(bodyRows()[0]?.textContent).toContain('View 1');
    expect(bodyRows()[0]?.textContent).toContain('Case 1');
    expect(bodyRows()[0]?.textContent).toContain('Local user');
    expect(bodyRows()[0]?.textContent).toContain('5 Nov 2026 13:00');
    expect(screen.getAllByRole('tab')[1]?.textContent).toBe('Saved views (3)');
    expect(screen.getByText('A named view is a saved copy of exploration state. It never changes; restoring one copies it into your own draft. An evidence pack is a signed, point-in-time record.')).toBeTruthy();
  });

  it('reaches all 30 views with Show more and moves the focus to the first new Open', async () => {
    const { client } = pagedClient(rowsOf(3), viewsOf(30));
    renderApp('/investigations?tab=views', client);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: /Open “View 1”/ });
    expect(document.querySelector('.investigations-status')?.textContent).toBe('Showing 25 of 30');
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(30));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Open “View 26”/ }));
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('says there are no named views', async () => {
    const { client } = pagedClient(rowsOf(1), []);
    renderApp('/investigations?tab=views', client);
    expect(await screen.findByText('No named views yet. Save one from an investigation.')).toBeTruthy();
  });

  it('keeps the rows when the next page fails and shows the failure with a retry; a failed first read shows no rows and a retry', async () => {
    const parts = pagedClient(rowsOf(1), viewsOf(30));
    let failing = false;
    const read = parts.client.listOwnedViews;
    const client: ApiClient = { ...parts.client, listOwnedViews: async (page, signal) => (failing ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : read(page, signal)) };
    renderApp('/investigations?tab=views', client);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: /Open “View 1”/ });
    failing = true;
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    await screen.findByText('The next investigations could not be read.');
    expect(bodyRows()).toHaveLength(25);
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(30));
  });

  it('follows the tabs pattern: arrows, Home and End move and select, the active tab is in the address, and only the active panel is drawn', async () => {
    const { client } = pagedClient(rowsOf(2), viewsOf(2));
    const view = renderApp('/investigations', client);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Case 1' });
    const [first, second, third] = screen.getAllByRole('tab');
    first?.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(second);
    expect(second?.getAttribute('aria-selected')).toBe('true');
    expect(view.router.state.location.search).toBe('?tab=views');
    await screen.findByRole('button', { name: /Open “View 1”/ });
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(third);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(first);
    expect(view.router.state.location.search).toBe('');
    expect(first?.getAttribute('tabindex')).toBe('0');
    expect(second?.getAttribute('tabindex')).toBe('-1');
  });
});

describe('the Evidence packs tab', () => {
  it('is reachable by keyboard, announced as unavailable in this edition, and shows its panel with no request', async () => {
    const { client, recorded } = pagedClient(rowsOf(2), viewsOf(2));
    renderApp('/investigations', client);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Case 1' });
    const tab = screen.getByRole('tab', { name: /Evidence packs/ });
    expect(tab.getAttribute('aria-disabled')).toBe('true');
    expect(tab.getAttribute('aria-describedby')).not.toBeNull();
    expect(document.getElementById(tab.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Evidence packs, Enterprise only');
    const pagesBefore = recorded.pages.length;
    tab.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('Evidence packs are an Enterprise capability. They are not available in this edition.')).toBeTruthy();
    expect(recorded.pages.length).toBe(pagesBefore);
    expect(recorded.views).toEqual([]);
  });
});

describe('Open on a saved view', () => {
  it('opens the investigation and asks "Replace your draft?" for that view; Cancel leaves the draft and opens the investigation', async () => {
    const parts = pagedClient(rowsOf(2), viewsOf(2));
    let restored = 0;
    const client: ApiClient = { ...parts.client, restoreView: async () => (restored++, { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) };
    const view = renderApp('/investigations?tab=views', client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Open “View 1”/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Replace your draft?' });
    expect(dialog.textContent).toContain('Restoring “View 1” replaces everything in your draft');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(restored).toBe(0);
    expect(view.router.state.location.pathname).toBe('/explore/0192f000-0000-7000-8000-000000000001');
    expect(view.router.state.location.state).toBeNull();
  });

  it('restores the view into the draft when the confirm is accepted', async () => {
    const parts = pagedClient(rowsOf(2), viewsOf(2));
    const requested: string[] = [];
    const client: ApiClient = {
      ...parts.client,
      restoreView: async (id, viewId, draftVersion) => {
        requested.push(`${id} ${viewId} ${draftVersion}`);
        const read = await parts.client.getInvestigation(id);
        if (!read.ok) return read;
        return { ok: true, value: { draft: { ...read.value.draft, version: draftVersion + 1, basedOnViewId: viewId }, save: { state: 'saved', savedAt: '2026-11-05T13:00:00.000Z' } } };
      },
    };
    renderApp('/investigations?tab=views', client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Open “View 2”/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Replace your draft?' });
    await user.click(within(dialog).getByRole('button', { name: 'Restore into draft' }));
    await waitFor(() => expect(requested).toEqual(['0192f000-0000-7000-8000-000000000002 0192f000-0000-7000-8000-000000005001 1']));
  });

  it('offers no restore for a view of a closed investigation, and says the view was not loaded', async () => {
    const closed = rowsOf(1, () => ({ status: 'closed' as const }));
    const views = viewsOf(1).map((view) => ({ ...view, investigation: { ...view.investigation, status: 'closed' as const } }));
    const parts = pagedClient(closed, views);
    let restored = 0;
    const client: ApiClient = { ...parts.client, restoreView: async () => (restored++, { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) };
    renderApp('/investigations?tab=views', client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Open “View 1”/ }));
    expect(await screen.findByText('This investigation is closed. The view was not loaded. Reopen it to restore a view.')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Replace your draft?' })).toBeNull();
    expect(restored).toBe(0);
  });
});
