import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { READ_WAIT_MS } from '../api/read-wait.js';
import { pagedClient, rowsOf, viewsOf } from '../investigations-page/page-fixtures.js';
import { clientWith, me, renderApp, source } from '../test-utils.js';
import { registerBuiltInSlots } from '../workspace/built-in-slots.js';
import { createSlotRegistry } from '../workspace/slots.js';
import { failure, INVESTIGATION_ID, namedView, rig, viewsServer } from './view-fixtures.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const wait = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const hang = () => new Promise<never>(() => undefined);
const press = async (element: HTMLElement) => {
  await act(async () => void fireEvent.click(element));
  await wait();
};
const UNREACHABLE = 'The server could not be reached.';
const NOT_LOADED = "Couldn't load the views.";
const three = (limit?: number) => viewsServer([namedView(3, { name: 'Third' }), namedView(2, { name: 'Second' }), namedView(1, { name: 'First' })], limit);

/** The workspace whose list of views gets no answer to the reads `hung` names, counted from 1. */
async function workspace(hung: (read: number) => boolean, options: { readonly limit?: number; readonly overrides?: Partial<ApiClient> } = {}) {
  const server = three(options.limit);
  let reads = 0;
  const base = clientWith({ me: me(), sources: [source('demo', { alias: 'fincrime' })] });
  const parts = rig({
    base,
    listViews: (...args) => (hung(++reads) ? hang() : server.listViews(...args)),
    renameView: server.renameView,
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
  });
  const slots = createSlotRegistry();
  registerBuiltInSlots(slots);
  renderApp(`/explore/${INVESTIGATION_ID}`, parts.client, parts.state, slots);
  await wait();
  const control = () => screen.getByRole('button', { name: /^Views/ });
  await press(control());
  return { reads: () => reads, control };
}
const panel = () => within(screen.getByRole('dialog', { name: /^Views/ }));

describe('the Views panel: a read that gets no answer', () => {
  it('ends the first read at the bound, with Retry, which reads', async () => {
    const view = await workspace((read) => read === 1);
    await wait(READ_WAIT_MS - 1);
    expect(panel().getByRole('status').textContent).not.toBe(NOT_LOADED);
    expect(panel().queryByRole('button', { name: 'Retry' })).toBeNull();
    await wait(1);
    expect(panel().getByRole('status').textContent).toBe(NOT_LOADED);
    await press(panel().getByRole('button', { name: 'Retry' }));
    expect(view.reads()).toBe(2);
    expect(panel().getByRole('heading', { name: 'Views · 3' })).toBeTruthy();
  });

  it('ends a reread of the panel opened again at the bound, with Retry, which reads', async () => {
    const view = await workspace((read) => read === 2);
    await press(view.control());
    await press(view.control());
    expect(view.reads()).toBe(2);
    await wait(READ_WAIT_MS - 1);
    expect(panel().getByRole('heading', { name: 'Views · 3' })).toBeTruthy();
    expect(panel().queryByText(NOT_LOADED)).toBeNull();
    await wait(1);
    expect(panel().getByText(NOT_LOADED)).toBeTruthy();
    await press(panel().getByRole('button', { name: 'Retry' }));
    expect(view.reads()).toBe(3);
    expect(panel().getByRole('heading', { name: 'Views · 3' })).toBeTruthy();
  });

  it('ends a Show more at the bound, frees the button, and a later press reads the page', async () => {
    const view = await workspace((read) => read === 2, { limit: 2 });
    await press(panel().getByRole('button', { name: 'Show more' }));
    const more = () => panel().getByRole('button', { name: /^(Show more|Loading…)$/ }) as HTMLButtonElement;
    await wait(READ_WAIT_MS - 1);
    expect(more().disabled).toBe(true);
    expect(more().getAttribute('aria-busy')).toBe('true');
    await wait(1);
    expect(more().disabled).toBe(false);
    expect(more().getAttribute('aria-busy')).toBe('false');
    expect(more().textContent).toBe('Show more');
    expect(panel().getAllByRole('listitem')).toHaveLength(2);
    expect(panel().getAllByRole('status').some((line) => line.classList.contains('views-error'))).toBe(true);
    await press(more());
    expect(view.reads()).toBe(3);
    expect(panel().getAllByRole('listitem')).toHaveLength(3);
  });

  it('ends a rename that waits for the list to be read again, and Retry reads it', async () => {
    const view = await workspace((read) => read === 2, { overrides: { renameView: async () => failure('CONFLICTED_VIEW_VERSION') } });
    await press(panel().getByRole('button', { name: 'Rename First' }));
    await act(async () => void fireEvent.submit(panel().getByRole('textbox', { name: 'Name of First' }).closest('form') as HTMLFormElement));
    await wait(READ_WAIT_MS - 1);
    expect(panel().getByRole('textbox', { name: 'Name of First' }).closest('form')?.querySelector('[aria-busy="true"]')).toBeTruthy();
    await wait(1);
    expect(panel().queryByRole('textbox')).toBeNull();
    expect(panel().getByText(NOT_LOADED)).toBeTruthy();
    await press(panel().getByRole('button', { name: 'Retry' }));
    expect(view.reads()).toBe(3);
    expect((panel().getByRole('button', { name: 'Rename First' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(['CONFLICTED_VIEW_VERSION', 'NOT_FOUND'])('ends a delete answered %s that waits for the list to be read again', async (code) => {
    const view = await workspace((read) => read === 2, { overrides: { deleteView: async () => failure(code) } });
    await press(panel().getByRole('button', { name: 'Delete First' }));
    const dialog = () => screen.queryByRole('dialog', { name: /^Delete “/ });
    await press(within(dialog() as HTMLElement).getByRole('button', { name: 'Delete view' }));
    await wait(READ_WAIT_MS - 1);
    expect(within(dialog() as HTMLElement).getByRole('button', { name: 'Deleting…' })).toBeTruthy();
    await wait(1);
    expect(dialog()).toBeNull();
    expect(panel().getByText(NOT_LOADED)).toBeTruthy();
    await press(panel().getByRole('button', { name: 'Retry' }));
    expect(view.reads()).toBe(3);
    expect((panel().getByRole('button', { name: 'Delete First' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

const bodyRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.investigations-table tbody tr')];

/** The Saved views tab whose list gets no answer to the reads `hung` names, counted from 1. */
async function viewsTab(hung: (read: number) => boolean, overrides: Partial<ApiClient> = {}) {
  const parts = pagedClient(rowsOf(1), viewsOf(30));
  const read = parts.client.listOwnedViews;
  let reads = 0;
  renderApp('/investigations?tab=views', { ...parts.client, listOwnedViews: (...args) => (hung(++reads) ? hang() : read(...args)), ...overrides });
  await wait();
  return { reads: () => reads };
}

describe('the Saved views tab: a read that gets no answer', () => {
  it('ends the first read at the bound, with Try again, which reads', async () => {
    const tab = await viewsTab((read) => read === 1);
    await wait(READ_WAIT_MS - 1);
    expect(screen.queryByText('The saved views could not be read.')).toBeNull();
    await wait(1);
    expect(screen.getByText('The saved views could not be read.')).toBeTruthy();
    expect(screen.getByText(UNREACHABLE)).toBeTruthy();
    await press(screen.getByRole('button', { name: 'Try again' }));
    expect(tab.reads()).toBe(2);
    expect(bodyRows()).toHaveLength(25);
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
  });

  it('ends the reread after a delete at the bound, keeps the rows, and reads on Try again', async () => {
    const tab = await viewsTab((read) => read === 2, { deleteView: async () => failure('NOT_FOUND') });
    await press(screen.getByRole('button', { name: 'Delete “View 1” from Case 1' }));
    await press(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete view' }));
    expect(tab.reads()).toBe(2);
    await wait(READ_WAIT_MS - 1);
    expect(screen.getByRole('table').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
    await wait(1);
    expect(screen.getByText(UNREACHABLE)).toBeTruthy();
    expect(screen.getByRole('table').getAttribute('aria-busy')).toBeNull();
    expect(bodyRows()).toHaveLength(25);
    await press(screen.getByRole('button', { name: 'Try again' }));
    expect(tab.reads()).toBe(3);
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
  });

  it('ends a Show more at the bound, frees the button, and Try again reads the page', async () => {
    const tab = await viewsTab((read) => read === 2);
    await press(screen.getByRole('button', { name: 'Show more' }));
    await wait(READ_WAIT_MS - 1);
    expect(screen.getByRole('button', { name: 'Loading…' }).getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
    await wait(1);
    expect(screen.getByText(UNREACHABLE)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show more' }).getAttribute('aria-busy')).toBeNull();
    await press(screen.getByRole('button', { name: 'Try again' }));
    expect(tab.reads()).toBe(3);
    expect(bodyRows()).toHaveLength(30);
  });
});
