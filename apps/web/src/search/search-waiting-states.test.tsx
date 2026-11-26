import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '@neburyx/contracts';
import { SEARCH_WAIT_MS } from '../api/read-wait.js';
import { renderApp } from '../test-utils.js';
import { drawn, end, ENDINGS, expectLine, held, timesSaid } from '../waiting-kit.js';
import { answerOf, hit, searchAt, searchKit } from './search-test-kit.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const WORD = 'Searching…';
const UNREACHABLE = 'The server could not be reached.';
const found = answerOf('demo', [hit('demo', 'AC-1')]);
const main = () => screen.getByRole('main');
const results = () => document.querySelector('.search-results') as HTMLElement;
const heading = () => screen.queryByRole('heading', { level: 2, name: /Exact ID match/ });

describe('the Search results while a first search is out', () => {
  it.each(ENDINGS)('says so once over hidden skeletons of the filters and the results, and stops on: %s', async (how) => {
    const reads = held<SearchResult>();
    const kit = searchKit(['demo'], (_request, signal) => reads.read(signal));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await drawn();
    const waiting = () => {
      expectLine(WORD, main());
      expect(results().getAttribute('aria-busy')).toBe('true');
      const shapes = [...main().querySelectorAll('.loading-shape')];
      expect(shapes).toHaveLength(2);
      for (const shape of shapes) {
        expect(shape.getAttribute('aria-hidden')).toBe('true');
        expect(shape.textContent).toBe('');
      }
      expect(main().querySelectorAll('.skeleton-result')).toHaveLength(7);
      expect(main().querySelectorAll('.skeleton-facets')).toHaveLength(2);
      expect(document.querySelector('.search-body-filtered')).not.toBeNull();
    };
    waiting();
    await end(how, reads.calls[0], found, SEARCH_WAIT_MS, waiting);
    expect(timesSaid(WORD)).toBe(0);
    expect(results().getAttribute('aria-busy')).toBe('false');
    expect(main().querySelector('.loading-shape')).toBeNull();
    expect(document.querySelector('.search-body-filtered')).toBeNull();
    if (how === 'answer') expect(heading()).toBeTruthy();
    else expect(within(main()).getByText(UNREACHABLE)).toBeTruthy();
  });
});

describe('the Search results while the same search is sent again', () => {
  it.each(ENDINGS)('keeps the earlier results usable, with one line and no skeleton, and stops on: %s', async (how) => {
    const reads = held<SearchResult>();
    let count = 0;
    const kit = searchKit(['demo'], (_request, signal) => (++count === 1 ? Promise.resolve({ ok: true, value: found }) : reads.read(signal)));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await drawn();
    await act(async () => void fireEvent.submit(within(main()).getByRole('searchbox').closest('form') as HTMLFormElement));
    await drawn();
    expect(reads.calls).toHaveLength(1);
    const waiting = () => {
      expectLine(WORD, main());
      expect(results().getAttribute('aria-busy')).toBe('true');
      expect(heading()).toBeTruthy();
      const row = within(results()).getByText('Title AC-1').closest('li') as HTMLElement;
      for (const button of within(row).getAllByRole('button')) {
        expect((button as HTMLButtonElement).disabled).toBe(false);
        expect(button.getAttribute('aria-disabled')).not.toBe('true');
      }
      expect(main().querySelector('.loading-shape')).toBeNull();
    };
    waiting();
    await end(how, reads.calls[0], found, SEARCH_WAIT_MS, waiting);
    expect(timesSaid(WORD)).toBe(0);
    expect(results().getAttribute('aria-busy')).toBe('false');
    expect(heading()).toBeTruthy();
    if (how !== 'answer') expect(within(main()).getByText(UNREACHABLE)).toBeTruthy();
  });
});
