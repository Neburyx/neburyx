import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderApp } from '../test-utils.js';
import { pagedClient, rowsOf } from './page-fixtures.js';

beforeAll(() => configure({ reactStrictMode: true }));
afterAll(() => configure({ reactStrictMode: false }));

const deletedRows = (count: number, overrides: (index: number) => Parameters<typeof rowsOf>[1] extends infer F ? (F extends (index: number) => infer R ? R : never) : never = () => ({})) =>
  rowsOf(count, (index) => ({ deletedAt: `2026-11-0${index + 1}T10:00:00.000Z`, purgeAfter: `2026-12-0${index + 1}T10:00:00.000Z`, ...overrides(index) }));

const bodyRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.investigations-table tbody tr')];
const status = (): string => document.querySelector('.investigations-status')?.textContent ?? '';
const restoreButton = (title: string): HTMLElement => screen.getByRole('button', { name: `Restore ${title}` });
const chip = (): HTMLElement => screen.getByRole('button', { name: 'Deleted' });

describe('the Deleted view of the Investigations page', () => {
  it('offers a Deleted chip and the retention line, and choosing it shows the deleted rows with their dates, the frame\'s sentence and no Status filter', async () => {
    const user = userEvent.setup();
    const { client, recorded } = pagedClient([...rowsOf(1), ...deletedRows(2).map((row, index) => ({ ...row, id: `0192f000-0000-7000-8000-00000000d00${index}`, title: `Gone ${index + 1}` }))]);
    renderApp('/investigations', client);
    await screen.findByRole('link', { name: 'Case 1' });
    expect(screen.getByText('Archived investigations are hidden. Deleted ones stay restorable for 30 days.')).toBeTruthy();
    expect(chip().getAttribute('aria-pressed')).toBe('false');
    await user.click(chip());
    await screen.findByText('Gone 1');
    expect(chip().getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('combobox', { name: 'Status' })).toBeNull();
    expect(screen.getByText('Restoring puts an investigation back as it was. Its named views, notes and shares return with it.')).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Title and referral', 'Starting entity', 'Source', 'Deleted (UTC)', 'Purges on (UTC)', 'Actions']);
    expect(bodyRows()).toHaveLength(2);
    expect(bodyRows()[0]?.textContent).toContain('1 Nov 2026 10:00');
    expect(bodyRows()[0]?.textContent).toContain('1 Dec 2026 10:00');
    expect(recorded.pages.at(-1)).toMatchObject({ deleted: true });
    expect(recorded.pages.at(-1)?.status).toBeUndefined();
  });

  it('has no link and no Open on a deleted row, shows the entity type and no label, and reads nothing from the source for it', async () => {
    const user = userEvent.setup();
    const { client, recorded } = pagedClient(deletedRows(2));
    renderApp('/investigations?deleted=1', client);
    await screen.findByText('Case 1');
    expect(screen.queryByRole('link', { name: 'Case 1' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Open/ })).toBeNull();
    expect(bodyRows()[0]?.textContent).not.toContain('Label E-1');
    expect(recorded.readRefs).toEqual([]);
    await waitFor(() => expect(bodyRows()[0]?.querySelectorAll('td')[1]?.textContent).toBe('KIND-A'));
    await user.click(chip());
    await screen.findByText(/Archived investigations are hidden/);
  });

  it('keeps the mode in the address, so a reload shows the Deleted view again', async () => {
    const { client } = pagedClient(deletedRows(1));
    renderApp('/investigations?deleted=1', client);
    await screen.findByText('Case 1');
    expect(chip().getAttribute('aria-pressed')).toBe('true');
  });

  it('says there is nothing deleted', async () => {
    const { client } = pagedClient(rowsOf(2));
    renderApp('/investigations?deleted=1', client);
    expect(await screen.findByText('No deleted investigations.')).toBeTruthy();
  });

  it('shows the page\'s error with Try again, and keeps the chip, when the read fails', async () => {
    const { client } = pagedClient(deletedRows(1), [], { listInvestigationPage: async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    renderApp('/investigations?deleted=1', client);
    expect(await screen.findByText('The investigations could not be read.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(chip().getAttribute('aria-pressed')).toBe('true');
  });

  it('reaches every deleted row with Show more', async () => {
    const user = userEvent.setup();
    const many = rowsOf(30, () => ({ deletedAt: '2026-11-01T10:00:00.000Z', purgeAfter: '2026-12-01T10:00:00.000Z' }));
    const { client } = pagedClient(many);
    renderApp('/investigations?deleted=1', client);
    await screen.findByText('Case 1');
    expect(bodyRows()).toHaveLength(25);
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(30));
  });
});

describe('Restore in the Deleted view', () => {
  it('removes the row, says it is restored, moves the focus to the next row\'s Restore, and puts the investigation back in its own status list', async () => {
    const user = userEvent.setup();
    const { client, recorded } = pagedClient(deletedRows(3, (index) => (index === 0 ? { status: 'closed' as const } : {})));
    renderApp('/investigations?deleted=1', client);
    await screen.findByText('Case 2');
    await user.click(restoreButton('Case 1'));
    await waitFor(() => expect(bodyRows()).toHaveLength(2));
    expect(recorded.restores).toEqual([{ id: expect.any(String), version: 1 }]);
    expect(status()).toBe('Investigation restored.');
    await waitFor(() => expect(document.activeElement).toBe(restoreButton('Case 2')));
    await user.click(chip());
    await screen.findByRole('combobox', { name: 'Status' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'closed');
    expect(await screen.findByRole('link', { name: 'Case 1' })).toBeTruthy();
  });

  it('moves the focus to the previous row when the last row was restored, and to the caption when none is left', async () => {
    const user = userEvent.setup();
    const { client } = pagedClient(deletedRows(2));
    renderApp('/investigations?deleted=1', client);
    await screen.findByText('Case 2');
    await user.click(restoreButton('Case 2'));
    await waitFor(() => expect(document.activeElement).toBe(restoreButton('Case 1')));
    await user.click(restoreButton('Case 1'));
    await screen.findByText('No deleted investigations.');
  });

  it('says it can no longer be restored and removes the row when the server answers NOT_FOUND', async () => {
    const user = userEvent.setup();
    const { client } = pagedClient(deletedRows(2), [], { restoreInvestigation: async () => ({ ok: false, failure: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 't' } }) });
    renderApp('/investigations?deleted=1', client);
    await screen.findByText('Case 2');
    await user.click(restoreButton('Case 1'));
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(status()).toBe('This investigation can no longer be restored. The list is updated.');
  });

  it('reads the list again after a version that changed elsewhere, and keeps the row and offers Restore again after an internal error', async () => {
    const user = userEvent.setup();
    let answer: 'conflict' | 'error' = 'conflict';
    const { client, recorded } = pagedClient(deletedRows(2), [], {
      restoreInvestigation: async () => ({ ok: false, failure: answer === 'conflict' ? { code: 'CONFLICT', message: 'This item was changed elsewhere. Reload to continue.', retryable: false, traceId: 't' } : { code: 'INTERNAL_ERROR', message: 'Something went wrong.', retryable: true, traceId: 't' } }),
    });
    renderApp('/investigations?deleted=1', client);
    await screen.findByText('Case 2');
    const before = recorded.pages.length;
    await user.click(restoreButton('Case 1'));
    await waitFor(() => expect(recorded.pages.length).toBeGreaterThan(before));
    expect((await screen.findByRole('alert')).textContent).toContain('This item was changed elsewhere');
    answer = 'error';
    await user.click(restoreButton('Case 1'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Something went wrong.'));
    expect(bodyRows()).toHaveLength(2);
    expect(restoreButton('Case 1')).toBeTruthy();
  });

  it('sends one request when Restore is pressed twice quickly', async () => {
    const user = userEvent.setup();
    let sent = 0;
    const { client } = pagedClient(deletedRows(1), [], {
      restoreInvestigation: () => {
        sent += 1;
        return new Promise(() => undefined);
      },
    });
    renderApp('/investigations?deleted=1', client);
    await screen.findByText('Case 1');
    await user.click(restoreButton('Case 1'));
    await user.click(restoreButton('Case 1'));
    expect(sent).toBe(1);
  });
});

describe('the note a delete from the workspace leaves on arrival', () => {
  it('is said once and is gone from the address state, so a reload or Back does not say it again', async () => {
    const { client } = pagedClient(rowsOf(2));
    const { router } = renderApp({ pathname: '/investigations', state: { notice: 'Investigation deleted. Restorable until 10 Dec 2026 10:00 UTC.' } }, client);
    await screen.findByRole('link', { name: 'Case 1' });
    expect(status()).toBe('Investigation deleted. Restorable until 10 Dec 2026 10:00 UTC.');
    await waitFor(() => expect(router.state.location.state).toBeNull());
  });
});

