import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PatternListResponse } from '@neburyx/contracts';
import { READ_WAIT_MS } from '../api/read-wait.js';
import { drawn, end, ENDINGS, expectLine, held, press, timesSaid } from '../waiting-kit.js';
import { page } from './library/library-kit.js';
import { listed, openPatterns, patternsWorkspace } from './patterns-kit.js';

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
const panel = () => screen.getByRole('complementary', { name: 'Patterns' });

/** The Patterns panel with two saved patterns, read again after a delete, that read still out. `more` answers a Load more when the first page has a cursor. */
async function reread(cursor: string | null = null, more?: (signal: AbortSignal | undefined) => ReturnType<ReturnType<typeof held<PatternListResponse>>['read']>) {
  const reads = held<PatternListResponse>();
  let firsts = 0;
  await patternsWorkspace({
    patterns: {
      listPatterns: (query, signal) => {
        if (query.cursor !== undefined && more !== undefined) return more(signal);
        return ++firsts === 1 ? Promise.resolve(page([ALPHA, BETA], cursor)) : reads.read(signal);
      },
      deletePattern: async () => deleted,
    },
  });
  await openPatterns();
  await drawn();
  expect(timesSaid(WORD)).toBe(0);
  await press(button('More: Alpha'));
  await press(screen.getByRole('menuitem', { name: 'Delete' }));
  await press(within(screen.getByRole('dialog', { name: /Delete/ })).getByRole('button', { name: 'Delete pattern' }));
  return reads;
}

const waiting = () => {
  expectLine(WORD, panel());
  expect(button('Run Alpha').disabled).toBe(false);
  expect(button('Run Beta').disabled).toBe(false);
  expect(button('More: Beta').disabled).toBe(false);
};

describe('the saved patterns of the Patterns panel while they are read again', () => {
  it.each(ENDINGS)('keeps the rows usable under one line, and stops on: %s', async (how) => {
    const reads = await reread();
    waiting();
    await end(how, reads.calls[0], { items: [BETA], nextCursor: null }, READ_WAIT_MS, waiting);
    expect(timesSaid(WORD)).toBe(0);
    expect(panel().querySelector('[aria-busy="true"]')).toBeNull();
    expect(button('Run Beta')).toBeTruthy();
    if (how !== 'answer') expect(within(panel()).getByRole('alert').textContent).toBe('The server could not be reached.');
  });

  it('marks the list busy while it waits', async () => {
    await reread();
    expect(expectLine(WORD, panel()).closest('[aria-busy="true"]')).not.toBeNull();
  });

  it.each(ENDINGS)('stops when Load more is pressed during the reread and its page ends in: %s', async (how) => {
    const pages = held<PatternListResponse>();
    await reread('c1', pages.read);
    waiting();
    await press(button('Load more'));
    await end(how, pages.calls[0], { items: [], nextCursor: null }, READ_WAIT_MS, () => undefined);
    expect(timesSaid(WORD)).toBe(0);
  });
});
