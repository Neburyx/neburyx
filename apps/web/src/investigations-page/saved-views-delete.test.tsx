import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OwnedView } from '@neburyx/contracts';
import type { ApiClient } from '../api/client.js';
import { renderApp } from '../test-utils.js';
import { pagedClient, rowsOf, viewsOf } from './page-fixtures.js';

beforeAll(() => configure({ reactStrictMode: true }));
afterAll(() => configure({ reactStrictMode: false }));

const bodyRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.investigations-table tbody tr')];
const status = (): string => document.querySelector('.investigations-status')?.textContent ?? '';
const tab = (): string => screen.getAllByRole('tab')[1]?.textContent ?? '';
const deleteButton = (view: string, investigation: string): HTMLElement => screen.getByRole('button', { name: `Delete “${view}” from ${investigation}` });

interface Deleted {
  readonly viewId: string;
  readonly version: number;
  readonly note: string | null;
}

function serverOf(views: OwnedView[], overrides: Partial<ApiClient> = {}) {
  const deleted: Deleted[] = [];
  const { client, recorded } = pagedClient(rowsOf(3), views, {
    deleteView: async (_id, viewId, version, note) => {
      deleted.push({ viewId, version, note });
      const at = views.findIndex((view) => view.id === viewId);
      if (at < 0) return { ok: false, failure: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 't' } };
      views.splice(at, 1);
      return { ok: true, value: { id: viewId, version: version + 1, deletedAt: '2026-11-10T10:00:00.000Z', draft: { version: 1, basedOnViewId: null }, save: { state: 'unsaved', savedAt: null }, count: { value: views.length, quality: 'exact', scope: 'named-views' } } };
    },
    ...overrides,
  });
  return { client, recorded, deleted };
}

describe('Delete in the Saved views tab', () => {
  it('puts a Delete after Open on every row, named with the view and its investigation, and opens a confirm that names both and asks for a note', async () => {
    const user = userEvent.setup();
    const { client } = serverOf(viewsOf(2));
    renderApp('/investigations?tab=views', client);
    await screen.findByRole('button', { name: /Open “View 1”/ });
    expect(bodyRows().map((row) => [...row.querySelectorAll('button')].map((button) => button.textContent))).toEqual([['Open', 'Delete'], ['Open', 'Delete']]);
    await user.click(deleteButton('View 1', 'Case 1'));
    const dialog = screen.getByRole('dialog', { name: 'Delete “View 1” from “Case 1”?' });
    expect(within(dialog).getByText("The view is deleted and can't be restored. Your draft is not changed.")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: 'Note (optional)' }));
  });

  it('returns the focus to that row\'s Delete when Escape or Cancel closes the dialog, and sends nothing', async () => {
    const user = userEvent.setup();
    const { client, deleted } = serverOf(viewsOf(2));
    renderApp('/investigations?tab=views', client);
    await screen.findByRole('button', { name: /Open “View 1”/ });
    await user.click(deleteButton('View 2', 'Case 2'));
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(deleteButton('View 2', 'Case 2'));
    await user.click(deleteButton('View 2', 'Case 2'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(deleteButton('View 2', 'Case 2'));
    expect(deleted).toEqual([]);
  });

  it('sends the row\'s version and the note, removes the row, takes the count down by one, says it, and moves the focus to the next row\'s Open', async () => {
    const user = userEvent.setup();
    const { client, deleted } = serverOf(viewsOf(3));
    renderApp('/investigations?tab=views', client);
    await screen.findByRole('button', { name: /Open “View 1”/ });
    expect(tab()).toBe('Saved views (3)');
    await user.click(deleteButton('View 2', 'Case 2'));
    await user.type(within(screen.getByRole('dialog')).getByRole('textbox'), 'old attempt');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete view' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(2));
    expect(deleted).toEqual([{ viewId: expect.any(String), version: 1, note: 'old attempt' }]);
    expect(tab()).toBe('Saved views (2)');
    expect(status()).toBe('View deleted.');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /Open “View 3”/ })));
  });

  it('moves the focus to the previous row when the last row is deleted, and to the caption when none is left', async () => {
    const user = userEvent.setup();
    const { client } = serverOf(viewsOf(2));
    renderApp('/investigations?tab=views', client);
    await screen.findByRole('button', { name: /Open “View 1”/ });
    await user.click(deleteButton('View 2', 'Case 2'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete view' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /Open “View 1”/ })));
    await user.click(deleteButton('View 1', 'Case 1'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete view' }));
    await screen.findByText('No named views yet. Save one from an investigation.');
  });

  it('disables Delete on a row of a closed or archived investigation, with the reason as its description, and sends nothing', async () => {
    const user = userEvent.setup();
    const views = viewsOf(2).map((view, index) => ({ ...view, investigation: { ...view.investigation, status: index === 0 ? ('closed' as const) : ('archived' as const) } }));
    const { client, deleted } = serverOf(views);
    renderApp('/investigations?tab=views', client);
    await screen.findByRole('button', { name: /Open “View 1”/ });
    const closed = deleteButton('View 1', 'Case 1') as HTMLButtonElement;
    const archived = deleteButton('View 2', 'Case 2') as HTMLButtonElement;
    expect([closed.disabled, archived.disabled]).toEqual([true, true]);
    expect(document.getElementById(closed.getAttribute('aria-describedby') ?? '')?.textContent).toBe('This investigation is closed. Reopen it to delete its views.');
    expect(document.getElementById(archived.getAttribute('aria-describedby') ?? '')?.textContent).toBe('This investigation is archived. Reopen it to delete its views.');
    await user.click(closed);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(deleted).toEqual([]);
  });

  it('shows the error\'s own message and keeps the row, when the investigation was closed elsewhere', async () => {
    const user = userEvent.setup();
    const message = 'This investigation is closed or archived. Reopen it to make changes.';
    const { client } = serverOf(viewsOf(2), { deleteView: async () => ({ ok: false, failure: { code: 'CONFLICT', message, retryable: false, traceId: 't', details: { reason: 'investigation-read-only', status: 'closed' } } }) });
    renderApp('/investigations?tab=views', client);
    await screen.findByRole('button', { name: /Open “View 1”/ });
    await user.click(deleteButton('View 1', 'Case 1'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete view' }));
    expect((await within(screen.getByRole('dialog')).findByRole('alert')).textContent).toBe(message);
    expect(bodyRows()).toHaveLength(2);
  });

  it('closes the dialog and reads the list again on a stale version, and on a view that is already deleted', async () => {
    const user = userEvent.setup();
    for (const [code, line] of [['CONFLICTED_VIEW_VERSION', 'This view was renamed elsewhere. The list is updated.'], ['NOT_FOUND', 'This view was already deleted. The list is updated.']] as const) {
      const { client, recorded } = serverOf(viewsOf(2), { deleteView: async () => ({ ok: false, failure: { code, message: 'x', retryable: false, traceId: 't' } }) });
      const view = renderApp('/investigations?tab=views', client);
      await screen.findByRole('button', { name: /Open “View 1”/ });
      const reads = recorded.views.length;
      await user.click(deleteButton('View 1', 'Case 1'));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete view' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => expect(recorded.views.length).toBeGreaterThan(reads));
      await waitFor(() => expect(status()).toBe(line));
      view.unmount();
    }
  });

  it('keeps the dialog, the note and the row after a network failure, and sends again', async () => {
    const user = userEvent.setup();
    let fail = true;
    const base = serverOf(viewsOf(2));
    const { client, deleted } = serverOf(viewsOf(2), { deleteView: async (id, viewId, version, note) => (fail ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : base.client.deleteView(id, viewId, version, note)) });
    renderApp('/investigations?tab=views', client);
    await screen.findByRole('button', { name: /Open “View 1”/ });
    await user.click(deleteButton('View 1', 'Case 1'));
    await user.type(within(screen.getByRole('dialog')).getByRole('textbox'), 'again');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete view' }));
    expect((await within(screen.getByRole('dialog')).findByRole('alert')).textContent).toBe('The request could not be sent. Try again.');
    expect((within(screen.getByRole('dialog')).getByRole('textbox') as HTMLTextAreaElement).value).toBe('again');
    expect(bodyRows()).toHaveLength(2);
    fail = false;
    expect(deleted).toEqual([]);
  });
});
