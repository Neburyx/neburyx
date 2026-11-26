import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PatternListResponse } from '@neburyx/contracts';
import { READ_WAIT_MS } from '../../api/read-wait.js';
import { end, ENDINGS, expectLine, held, press, timesSaid, wait } from '../../waiting-kit.js';
import { libraryPage, listed, page, tableRows } from './library-kit.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const WORD = 'Reading again…';
const ALPHA = listed({ id: '0192f000-0000-7000-8000-000000000001', name: 'Alpha' });
const BETA = listed({ id: '0192f000-0000-7000-8000-000000000002', name: 'Beta' });
const deleted = { ok: true as const, value: { id: ALPHA.id, version: 2, deletedAt: '2026-11-12T10:00:00.000Z', purgeAfter: '2026-12-12T10:00:00.000Z' } };
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const tabPanel = () => screen.getByRole('tabpanel');

/** The library with two saved patterns, read again after a delete, that read still out. `more` answers a Load more when the first page has a cursor. */
async function reread(cursor: string | null = null, more?: (signal: AbortSignal | undefined) => ReturnType<ReturnType<typeof held<PatternListResponse>>['read']>) {
  const reads = held<PatternListResponse>();
  let firsts = 0;
  await libraryPage({
    patterns: {
      listPatterns: (query, signal) => {
        if (query.cursor !== undefined && more !== undefined) return more(signal);
        return ++firsts === 1 ? Promise.resolve(page([ALPHA, BETA], cursor)) : reads.read(signal);
      },
      deletePattern: async () => deleted,
    },
  });
  await wait();
  expect(timesSaid(WORD)).toBe(0);
  await press(button('More: Alpha'));
  await press(screen.getByRole('menuitem', { name: 'Delete' }));
  await press(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete pattern' }));
  return reads;
}

const waiting = () => {
  expectLine(WORD, tabPanel());
  expect(tabPanel().getAttribute('aria-busy')).toBe('true');
  expect(tableRows()).toHaveLength(2);
  expect(button('Run Beta').disabled).toBe(false);
  expect(button('More: Beta').disabled).toBe(false);
};
const after = () => {
  expect(timesSaid(WORD)).toBe(0);
  expect(tabPanel().getAttribute('aria-busy')).toBeNull();
};

describe('the patterns library while the saved patterns are read again', () => {
  it.each(ENDINGS)('keeps the rows usable under one line in a busy panel, and stops on: %s', async (how) => {
    const reads = await reread();
    waiting();
    await end(how, reads.calls[0], { items: [BETA], nextCursor: null }, READ_WAIT_MS, waiting);
    after();
    expect(tableRows()).toHaveLength(how === 'answer' ? 1 : 2);
    if (how !== 'answer') expect(screen.getByRole('alert').textContent).toBe('The server could not be reached.');
  });

  it.each(ENDINGS)('stops when Load more is pressed during the reread and its page ends in: %s', async (how) => {
    const pages = held<PatternListResponse>();
    await reread('c1', pages.read);
    waiting();
    await press(button('Load more'));
    await end(how, pages.calls[0], { items: [], nextCursor: null }, READ_WAIT_MS, () => undefined);
    after();
  });
});
