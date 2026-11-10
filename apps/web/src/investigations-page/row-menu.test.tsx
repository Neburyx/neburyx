import { act, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { renderApp } from '../test-utils.js';
import { pagedClient, rowsOf } from './page-fixtures.js';

beforeAll(() => configure({ reactStrictMode: true }));
afterAll(() => configure({ reactStrictMode: false }));

const bodyRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.investigations-table tbody tr')];
const status = (): string => document.querySelector('.investigations-status')?.textContent ?? '';
const menuButton = (title: string): HTMLElement => screen.getByRole('button', { name: `Actions for ${title}` });
const itemsOf = (): string[] => screen.getAllByRole('menuitem').map((item) => item.querySelector('.menu-label')?.textContent ?? '');

describe('the row menu', () => {
  it('offers Open, Rename, Close and Archive for an open investigation, and never Delete', async () => {
    const { client } = pagedClient(rowsOf(2));
    renderApp('/investigations', client);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Case 1' });
    await user.click(menuButton('Case 1'));
    expect(itemsOf()).toEqual(['Open', 'Rename', 'Close', 'Archive']);
  });

  it('offers Reopen and Archive for a closed one, and Reopen for an archived one, with Rename disabled and saying why', async () => {
    const { client } = pagedClient(rowsOf(3, (index) => ({ status: index === 0 ? ('closed' as const) : index === 1 ? ('archived' as const) : ('open' as const) })));
    renderApp('/investigations?status=closed', client);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Case 1' });
    await user.click(menuButton('Case 1'));
    expect(itemsOf()).toEqual(['Open', 'Rename', 'Reopen', 'Archive']);
    const rename = screen.getByRole('menuitem', { name: /Rename/ });
    expect(rename.getAttribute('aria-disabled')).toBe('true');
    expect(rename.textContent).toContain('Reopen to rename.');
    await user.keyboard('{Escape}');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'archived');
    await screen.findByRole('link', { name: 'Case 2' });
    await user.click(menuButton('Case 2'));
    expect(itemsOf()).toEqual(['Open', 'Rename', 'Reopen']);
  });

  it('closes an investigation with its version, takes the row out of the Open list, says so and moves the focus to the next row', async () => {
    const { client, recorded } = pagedClient(rowsOf(3));
    renderApp('/investigations', client);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Case 1' });
    await user.click(menuButton('Case 1'));
    await user.click(screen.getByRole('menuitem', { name: 'Close' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(2));
    expect(recorded.statusChanges).toEqual([{ id: '0192f000-0000-7000-8000-000000000001', status: 'closed', version: 1 }]);
    expect(status()).toBe('“Case 1” is closed. It is no longer in this list.');
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Case 2' }));
    expect(screen.getAllByRole('tab')[0]?.textContent).toBe('Investigations (2)');
  });

  it('moves the focus to the previous row when the last one leaves, and to the message that replaces the table when none is left', async () => {
    const { client } = pagedClient(rowsOf(2));
    renderApp('/investigations', client);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Case 2' });
    await user.click(menuButton('Case 2'));
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Case 1' }));
    await user.click(menuButton('Case 1'));
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(document.activeElement?.textContent).toContain('No investigations'));
  });

  it('renames from the dialog and shows the new title with the new version used for the next change', async () => {
    const parts = pagedClient(rowsOf(2));
    const [first] = rowsOf(1);
    if (first === undefined) throw new Error('no row');
    const { sourceAlias: _alias, save: _save, nodeCount: _nodes, edgeCount: _edges, ...investigation } = first;
    const client: ApiClient = { ...parts.client, renameInvestigation: async (id, title, version) => ({ ok: true, value: { investigation: { ...investigation, id, title, version: version + 1 } } }) };
    renderApp('/investigations', client);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Case 1' });
    await user.click(menuButton('Case 1'));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename investigation' });
    expect(within(dialog).getByText("Don't type customer names; others may see this text.")).toBeTruthy();
    const input = within(dialog).getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'Renamed case');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await screen.findByRole('link', { name: 'Renamed case' });
    expect(document.activeElement).toBe(menuButton('Renamed case'));
    await user.click(menuButton('Renamed case'));
    await user.click(screen.getByRole('menuitem', { name: 'Close' }));
    await waitFor(() => expect(parts.recorded.statusChanges[0]?.version).toBe(2));
  });

  it.each([
    ['a stale version', { code: 'CONFLICT', message: 'This item was changed elsewhere. Reload to continue.', retryable: false, traceId: 't' } as const],
    ['a missing investigation', { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 't' } as const],
    ['a network failure', { code: 'NETWORK_UNAVAILABLE' } as const],
  ])('keeps the row and the focus and shows the failure for %s', async (_name, failure) => {
    const parts = pagedClient(rowsOf(2));
    const client: ApiClient = { ...parts.client, changeInvestigationStatus: async () => ({ ok: false, failure }) };
    renderApp('/investigations', client);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Case 1' });
    await user.click(menuButton('Case 1'));
    await user.click(screen.getByRole('menuitem', { name: 'Close' }));
    await waitFor(() => expect(document.querySelector('.investigations-notice')).not.toBeNull());
    expect(bodyRows()).toHaveLength(2);
    expect(document.querySelector('.investigations-notice')?.getAttribute('role')).toBe('alert');
    expect(document.activeElement).toBe(menuButton('Case 1'));
  });

  it('reads the row again after a stale version, so the next change carries the version the server holds', async () => {
    const parts = pagedClient(rowsOf(2));
    let first = true;
    const client: ApiClient = {
      ...parts.client,
      changeInvestigationStatus: async (id, target, version) => {
        if (first) {
          first = false;
          return { ok: false, failure: { code: 'CONFLICT', message: 'This item was changed elsewhere. Reload to continue.', retryable: false, traceId: 't' } };
        }
        return parts.client.changeInvestigationStatus(id, target, version);
      },
      getInvestigation: async (id) => {
        const read = await parts.client.getInvestigation(id);
        return read.ok ? { ok: true, value: { ...read.value, investigation: { ...read.value.investigation, version: 7, title: 'Changed elsewhere' } } } : read;
      },
    };
    renderApp('/investigations', client);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Case 1' });
    await user.click(menuButton('Case 1'));
    await user.click(screen.getByRole('menuitem', { name: 'Close' }));
    await screen.findByRole('link', { name: 'Changed elsewhere' });
    await user.click(menuButton('Changed elsewhere'));
    await user.click(screen.getByRole('menuitem', { name: 'Close' }));
    await waitFor(() => expect(parts.recorded.statusChanges.at(-1)?.version).toBe(7));
  });

  it('sends one request for two choices while a change is under way', async () => {
    const parts = pagedClient(rowsOf(2));
    let release: () => void = () => undefined;
    let asked = 0;
    const client: ApiClient = {
      ...parts.client,
      changeInvestigationStatus: async (id, target, version) => {
        asked += 1;
        await new Promise<void>((resolve) => (release = resolve));
        return parts.client.changeInvestigationStatus(id, target, version);
      },
    };
    renderApp('/investigations', client);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Case 1' });
    await user.click(menuButton('Case 1'));
    await user.click(screen.getByRole('menuitem', { name: 'Close' }));
    await user.click(menuButton('Case 1'));
    expect(screen.getByRole('menuitem', { name: 'Close' }).getAttribute('aria-disabled')).toBe('true');
    await user.click(screen.getByRole('menuitem', { name: 'Close' }));
    expect(asked).toBe(1);
    await act(async () => release());
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
  });

  it('works from the keyboard: Enter opens it on the first item, the arrows move, Esc closes it and returns to the button, and Open goes to the investigation', async () => {
    const { client } = pagedClient(rowsOf(2));
    const view = renderApp('/investigations', client);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Case 1' });
    const button = menuButton('Case 1');
    button.focus();
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Open' }));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/explore/0192f000-0000-7000-8000-000000000001'));
  });
});
