import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { READ_WAIT_MS } from '../../api/read-wait.js';
import { profiled } from '../../search/search-test-kit.js';
import { listOf } from '../patterns-kit.js';
import { libraryPage, listed, page, tab, tableRows } from './library-kit.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const wait = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const hang = () => new Promise<never>(() => undefined);
const press = async (element: HTMLElement) => {
  await act(async () => void fireEvent.click(element));
  await wait();
};
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const UNREACHABLE = 'The server could not be reached.';
const ALPHA = listed({ id: '0192f000-0000-7000-8000-000000000001', name: 'Alpha' });
const BETA = listed({ id: '0192f000-0000-7000-8000-000000000002', name: 'Beta' });
const deleted = { ok: true as const, value: { id: ALPHA.id, version: 2, deletedAt: '2026-11-12T10:00:00.000Z', purgeAfter: '2026-12-12T10:00:00.000Z' } };
const remove = async (name: string) => {
  await press(button(`More: ${name}`));
  await press(screen.getByRole('menuitem', { name: 'Delete' }));
  await press(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete pattern' }));
};

describe('the patterns library: a read that gets no answer', () => {
  it('ends the first read of the saved patterns at the bound, with Try again, which reads', async () => {
    let reads = 0;
    const kit = await libraryPage({ patterns: { listPatterns: () => (++reads === 1 ? hang() : Promise.resolve(page([ALPHA]))) } });
    await wait(READ_WAIT_MS - 1);
    expect(screen.getByText('Loading saved patterns…')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    await wait(1);
    expect(screen.getByRole('alert').textContent).toContain(UNREACHABLE);
    expect(screen.queryByText('Loading saved patterns…')).toBeNull();
    await press(button('Try again'));
    expect(kit.queries).toHaveLength(2);
    expect(tableRows()[0]).toContain('Alpha');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ends a reread at the bound, keeps the rows and says so, and the next change reads again', async () => {
    let reads = 0;
    const kit = await libraryPage({ patterns: { listPatterns: () => (++reads === 2 ? hang() : Promise.resolve(page(reads === 1 ? [ALPHA, BETA] : []))), deletePattern: async () => deleted } });
    await remove('Alpha');
    expect(kit.queries).toHaveLength(2);
    await wait(READ_WAIT_MS - 1);
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
    await wait(1);
    expect(screen.getByRole('alert').textContent).toBe(UNREACHABLE);
    expect(tableRows()).toHaveLength(2);
    await remove('Beta');
    expect(kit.queries).toHaveLength(3);
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
    expect(screen.queryByRole('row', { name: /Beta/ })).toBeNull();
  });

  it('ends a Load more at the bound, frees the button, and a later press reads the page', async () => {
    let more = 0;
    const kit = await libraryPage({ patterns: { listPatterns: (query) => (query.cursor === undefined ? Promise.resolve(page([ALPHA], 'c1')) : ++more === 1 ? hang() : Promise.resolve(page([BETA]))) } });
    await press(button('Load more'));
    await wait(READ_WAIT_MS - 1);
    expect(button('Load more').disabled).toBe(true);
    expect(button('Load more').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
    await wait(1);
    expect(screen.getByRole('alert').textContent).toBe(UNREACHABLE);
    expect(button('Load more').disabled).toBe(false);
    expect(button('Load more').getAttribute('aria-busy')).toBeNull();
    await press(button('Load more'));
    expect(kit.queries.map((query) => query.cursor)).toEqual([undefined, 'c1', 'c1']);
    expect(tableRows()).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ends the read of the built-in patterns at the bound, with Try again, which reads', async () => {
    let reads = 0;
    await libraryPage({ templates: () => (++reads === 1 ? hang() : Promise.resolve({ ok: true as const, value: listOf() })) });
    await press(tab(/^Built-in/));
    await wait(READ_WAIT_MS - 1);
    expect(screen.getByRole('tabpanel').textContent).toContain('Loading saved patterns…');
    expect(screen.queryByRole('alert')).toBeNull();
    await wait(1);
    expect(screen.getByText(UNREACHABLE)).toBeTruthy();
    await press(button('Try again'));
    expect(reads).toBe(2);
    expect(tableRows()).toHaveLength(3);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ends the read of the source profile at the bound, says names could not be read, and reads it on Try again', async () => {
    let reads = 0;
    await libraryPage({ patterns: { listPatterns: async () => page([ALPHA]) }, profile: (sourceId) => (++reads === 1 ? hang() : Promise.resolve({ ok: true as const, value: profiled(sourceId) })) });
    await wait(READ_WAIT_MS - 1);
    expect(screen.queryByRole('alert')).toBeNull();
    await wait(1);
    expect(screen.getByRole('alert').textContent).toContain('Some names could not be read');
    await press(within(screen.getByRole('alert')).getByRole('button', { name: 'Try again' }));
    expect(reads).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
