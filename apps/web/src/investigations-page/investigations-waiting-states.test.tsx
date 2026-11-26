import { act, cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvestigationListResponse } from '@neburyx/contracts';
import type { ApiClient } from '../api/client.js';
import { READ_WAIT_MS } from '../api/read-wait.js';
import { renderApp } from '../test-utils.js';
import { drawn, end, ENDINGS, held, press, statuses, timesSaid, wait } from '../waiting-kit.js';
import { pagedClient, rowsOf, viewsOf } from './page-fixtures.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const UNREACHABLE = 'The server could not be reached.';
const bodyRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.investigations-table tbody tr')];
const shape = () => document.querySelector('.loading-shape');

function expectTableSkeleton(rows: number) {
  expect(document.querySelectorAll('.loading-shape')).toHaveLength(1);
  expect(shape()?.parentElement?.getAttribute('aria-busy')).toBe('true');
  expect(shape()?.getAttribute('aria-hidden')).toBe('true');
  expect(shape()?.querySelectorAll('.skeleton-table-row')).toHaveLength(rows);
  expect(shape()?.textContent).toBe('');
}

describe('the Investigations list while its first read is out', () => {
  const SENTENCE = 'Loading investigations…';

  it.each(ENDINGS)('says so once over a hidden table skeleton, and stops on: %s', async (how) => {
    const parts = pagedClient(rowsOf(3));
    const answer = await parts.client.listInvestigationPage({});
    if (!answer.ok) throw new Error('no page');
    const reads = held<InvestigationListResponse>();
    renderApp('/investigations', { ...parts.client, listInvestigationPage: (_query, signal) => reads.read(signal) });
    await drawn();
    const waiting = () => {
      expectTableSkeleton(7);
      expect(statuses(SENTENCE)).toHaveLength(1);
      expect(timesSaid(SENTENCE)).toBe(1);
    };
    waiting();
    await end(how, reads.calls[0], answer.value, READ_WAIT_MS, waiting);
    expect(shape()).toBeNull();
    expect(timesSaid(SENTENCE)).toBe(0);
    expect(document.querySelector('.investigations-page [aria-busy="true"]')).toBeNull();
    if (how === 'answer') expect(bodyRows()).toHaveLength(3);
    else expect(screen.getByText(UNREACHABLE)).toBeTruthy();
  });

  it('draws the skeleton again for the read of Try again', async () => {
    const parts = pagedClient(rowsOf(3));
    const reads = held<InvestigationListResponse>();
    renderApp('/investigations', { ...parts.client, listInvestigationPage: (_query, signal) => reads.read(signal) });
    await drawn();
    await wait(READ_WAIT_MS);
    await press(screen.getByRole('button', { name: 'Try again' }));
    expectTableSkeleton(7);
    expect(statuses(SENTENCE)).toHaveLength(1);
  });
});

describe('the Saved views tab while its first read is out', () => {
  const SENTENCE = 'Loading views…';

  it.each(ENDINGS)('says so once over a hidden table skeleton, and stops on: %s', async (how) => {
    const parts = pagedClient(rowsOf(1), viewsOf(3));
    const answer = await parts.client.listOwnedViews({});
    if (!answer.ok) throw new Error('no page');
    const reads = held<typeof answer.value>();
    renderApp('/investigations?tab=views', { ...parts.client, listOwnedViews: (_page, signal) => reads.read(signal) });
    await drawn();
    const waiting = () => {
      expectTableSkeleton(5);
      expect(statuses(SENTENCE)).toHaveLength(1);
      expect(timesSaid(SENTENCE)).toBe(1);
      expect(timesSaid('Reading again…')).toBe(0);
    };
    waiting();
    await end(how, reads.calls[0], answer.value, READ_WAIT_MS, waiting);
    expect(shape()).toBeNull();
    expect(timesSaid(SENTENCE)).toBe(0);
    expect(document.querySelector('.investigations-views [aria-busy="true"]')).toBeNull();
    if (how === 'answer') expect(bodyRows()).toHaveLength(3);
    else expect(screen.getByText(UNREACHABLE)).toBeTruthy();
  });
});

describe('the Saved views tab while it is read again', () => {
  const WORD = 'Reading again…';

  it.each(ENDINGS)('keeps the rows usable under one line in a busy table, and stops on: %s', async (how) => {
    const parts = pagedClient(rowsOf(1), viewsOf(3));
    const first = await parts.client.listOwnedViews({});
    if (!first.ok) throw new Error('no page');
    const reads = held<typeof first.value>();
    let count = 0;
    const client: ApiClient = {
      ...parts.client,
      listOwnedViews: (_page, signal) => (++count === 1 ? Promise.resolve(first) : reads.read(signal)),
      deleteView: async () => ({ ok: false, failure: { code: 'NOT_FOUND', message: 'x', retryable: false, traceId: 't' } }),
    };
    renderApp('/investigations?tab=views', client);
    await drawn();
    await press(screen.getByRole('button', { name: 'Delete “View 1” from Case 1' }));
    await press(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete view' }));
    const waiting = () => {
      expect(statuses(WORD)).toHaveLength(1);
      expect(timesSaid(WORD)).toBe(1);
      expect(statuses(WORD)[0]?.querySelector('.waiting-spinner')?.getAttribute('aria-hidden')).toBe('true');
      expect(screen.getByRole('table').getAttribute('aria-busy')).toBe('true');
      expect(bodyRows()).toHaveLength(3);
      for (const open of screen.getAllByRole('button', { name: /^Open / })) expect((open as HTMLButtonElement).disabled).toBe(false);
      for (const remove of screen.getAllByRole('button', { name: /^Delete “/ })) expect((remove as HTMLButtonElement).disabled).toBe(false);
      expect(shape()).toBeNull();
    };
    waiting();
    await act(async () => undefined);
    await end(how, reads.calls[0], first.value, READ_WAIT_MS, waiting);
    expect(timesSaid(WORD)).toBe(0);
    expect(screen.getByRole('table').getAttribute('aria-busy')).toBeNull();
    expect(bodyRows()).toHaveLength(3);
    if (how !== 'answer') expect(screen.getByText(UNREACHABLE)).toBeTruthy();
  });
});
