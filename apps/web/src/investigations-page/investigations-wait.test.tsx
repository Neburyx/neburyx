import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvestigationPageQuery } from '../api/client.js';
import { READ_WAIT_MS } from '../api/read-wait.js';
import { testProfile } from '../dev/test-profile.js';
import { renderApp } from '../test-utils.js';
import { pagedClient, rowsOf } from './page-fixtures.js';

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
const bodyRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.investigations-table tbody tr')];
const status = (): string => document.querySelector('.investigations-status')?.textContent ?? '';
const UNREACHABLE = 'The server could not be reached.';
const button = (name: string) => screen.getByRole('button', { name });

/** A list client whose reads hang while `hung` says so. */
function listing(hung: (query: InvestigationPageQuery, call: number) => boolean) {
  const parts = pagedClient(rowsOf(60, (index) => (index < 3 ? { status: 'closed' as const } : {})));
  const read = parts.client.listInvestigationPage;
  const asked: InvestigationPageQuery[] = [];
  const client = {
    ...parts.client,
    listInvestigationPage: (query: InvestigationPageQuery, signal?: AbortSignal) => {
      asked.push(query);
      return hung(query, asked.length) ? hang() : read(query, signal);
    },
  };
  return { client, asked };
}

describe('the Investigations page: a list read that gets no answer', () => {
  it('stops waiting for the first read at the bound, says so with Try again, and reads on Try again', async () => {
    const parts = listing((_query, call) => call === 1);
    renderApp('/investigations', parts.client);
    await wait(READ_WAIT_MS - 1);
    expect(status()).toBe('Loading investigations…');
    expect(screen.queryByText('The investigations could not be read.')).toBeNull();
    await wait(1);
    expect(screen.getByText('The investigations could not be read.')).toBeTruthy();
    expect(screen.getByText(UNREACHABLE)).toBeTruthy();
    expect(status()).toBe('');
    await press(button('Try again'));
    expect(parts.asked).toHaveLength(2);
    expect(bodyRows()).toHaveLength(25);
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
  });

  it('ends a reread after a change of filter, keeps the rows, and reads on Try again', async () => {
    const parts = listing((_query, call) => call === 2);
    renderApp('/investigations', parts.client);
    await wait();
    await act(async () => void fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'closed' } }));
    await wait(READ_WAIT_MS - 1);
    expect(screen.getByRole('table').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
    await wait(1);
    expect(screen.getByText('The investigations could not be read.')).toBeTruthy();
    expect(screen.getByText(UNREACHABLE)).toBeTruthy();
    expect(screen.getByRole('table').getAttribute('aria-busy')).toBeNull();
    expect(bodyRows()).toHaveLength(25);
    await press(button('Try again'));
    expect(parts.asked).toHaveLength(3);
    expect(bodyRows()).toHaveLength(3);
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
  });

  it('ends a Show more at the bound, frees the button, and reads the same page on Try again', async () => {
    const parts = listing((_query, call) => call === 2);
    renderApp('/investigations', parts.client);
    await wait();
    await press(button('Show more'));
    await wait(READ_WAIT_MS - 1);
    expect(button('Loading…').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
    await wait(1);
    expect(screen.getByText('The next investigations could not be read.')).toBeTruthy();
    expect(screen.getByText(UNREACHABLE)).toBeTruthy();
    expect(button('Show more').getAttribute('aria-busy')).toBeNull();
    expect(bodyRows()).toHaveLength(25);
    await press(button('Try again'));
    expect(parts.asked[2]?.cursor).toBe(parts.asked[1]?.cursor);
    expect(bodyRows()).toHaveLength(50);
    await press(button('Show more'));
    expect(bodyRows()).toHaveLength(57);
  });
});

describe('the Investigations page: a row label or a source profile that gets no answer', () => {
  it('stops waiting for the labels without a message and asks for them again at the next list read', async () => {
    const parts = pagedClient(rowsOf(60));
    const read = parts.client.readRefs;
    const asked: string[][] = [];
    const client = {
      ...parts.client,
      readRefs: (...args: Parameters<typeof read>) => {
        asked.push(args[0].entities.map((entity) => entity.stableId));
        // one call for each of the two sources of the first page
        return asked.length <= 2 ? hang() : read(...args);
      },
    };
    renderApp('/investigations', client);
    await wait();
    expect(asked).toHaveLength(2);
    await wait(READ_WAIT_MS - 1);
    await press(button('Show more'));
    expect(asked.slice(2).flat()).not.toContain('E-1');
    const before = asked.length;
    await wait(1);
    expect(asked).toHaveLength(before);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
    expect(bodyRows()[0]?.textContent).not.toContain('Label E-1');
    await press(button('Show more'));
    expect(asked.slice(before).flat()).toContain('E-1');
    expect(asked.slice(before).flat()).toContain('E-2');
    expect(bodyRows()[0]?.textContent).toContain('Label E-1');
    expect(bodyRows()[1]?.textContent).toContain('Label E-2');
  });

  it('stops waiting for a source profile without a message and asks for it again at the next list read', async () => {
    const parts = pagedClient(rowsOf(60));
    const asked: string[] = [];
    const client = {
      ...parts.client,
      getProfile: (sourceId: string) => {
        asked.push(sourceId);
        return asked.length <= 2 ? hang() : Promise.resolve({ ok: true as const, value: testProfile(sourceId) });
      },
    };
    renderApp('/investigations', client);
    await wait();
    expect([...asked].sort()).toEqual(['source-a', 'source-b']);
    await wait(READ_WAIT_MS - 1);
    await press(button('Show more'));
    expect(asked).toHaveLength(2);
    await wait(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
    expect(bodyRows()[0]?.textContent).not.toContain('KIND-A');
    await press(button('Show more'));
    expect([...asked.slice(2)].sort()).toEqual(['source-a', 'source-b']);
    expect(bodyRows()[0]?.textContent).toContain('KIND-A');
  });
});
