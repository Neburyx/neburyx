import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '@neburyx/contracts';
import { SEARCH_WAIT_MS } from '../api/read-wait.js';
import { SEARCH_DEBOUNCE_MS } from '../patterns/start-entity.js';
import { answerOf } from '../search/search-test-kit.js';
import { drawn, end, ENDINGS, expectLine, held, press, timesSaid, wait } from '../waiting-kit.js';
import { typedNode } from '../workspace/filters-kit.js';
import { PATHS_COPY } from './copy.js';
import { openPaths, pathsWorkspace } from './paths-kit.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const WORD = 'Searching…';
const found = answerOf('a', [typedNode('far-1', 'kind-a')]);

async function opened() {
  const reads = held<SearchResult>();
  await pathsWorkspace({ search: (_request, signal) => reads.read(signal) });
  await openPaths();
  return reads;
}

describe.each(['From', 'To'])('the %s picker of the paths panel while a search is out', (label) => {
  const input = () => screen.getByLabelText(label) as HTMLInputElement;
  const field = () => input().closest('.paths-end') as HTMLElement;
  const type = async (text: string) => {
    await act(async () => {
      fireEvent.focus(input());
      fireEvent.change(input(), { target: { value: text } });
    });
    await wait(SEARCH_DEBOUNCE_MS);
  };
  const waiting = () => {
    expectLine(WORD, field());
    expect(timesSaid(WORD)).toBe(1);
    expect(field().getAttribute('aria-busy')).toBe('true');
    expect(input().disabled).toBe(false);
  };
  const after = () => {
    expect(timesSaid(WORD)).toBe(0);
    expect(field().getAttribute('aria-busy')).toBeNull();
  };

  it.each(ENDINGS)('says Searching… once in a busy field, from the typing on, and stops on: %s', async (how) => {
    const reads = await opened();
    await act(async () => void fireEvent.change(input(), { target: { value: 'far' } }));
    waiting();
    await wait(SEARCH_DEBOUNCE_MS);
    waiting();
    await end(how, reads.calls[0], found, SEARCH_WAIT_MS, waiting);
    after();
    if (how !== 'answer') expect(within(field()).getByRole('alert').textContent).toBe(PATHS_COPY.searchFailed);
  });

  it.each(ENDINGS)('keeps the earlier results listed and usable during the next search, and stops on: %s', async (how) => {
    const reads = await opened();
    await type('far');
    await act(async () => reads.calls[0]?.settle({ ok: true, value: found }));
    await type('far-');
    const listed = () => within(field()).getByRole('option', { name: /^far-1/ });
    const during = () => {
      waiting();
      expect(listed().getAttribute('aria-disabled')).toBeNull();
    };
    during();
    await end(how, reads.calls[1], found, SEARCH_WAIT_MS, during);
    after();
    expect(listed()).toBeTruthy();
    await press(listed());
    expect(input().value).toBe('far-1');
  });

  it('shows the wait in place of the failure while Try again searches', async () => {
    const reads = await opened();
    await type('far');
    await end('failure', reads.calls[0], found, SEARCH_WAIT_MS, () => undefined);
    await press(within(field()).getByRole('button', { name: /try again|retry|search/i }));
    waiting();
    expect(within(field()).queryByRole('alert')).toBeNull();
    await wait(SEARCH_DEBOUNCE_MS + SEARCH_WAIT_MS);
    await drawn();
    after();
  });

  it('stops saying Searching… when the text is cleared while the search is out', async () => {
    await opened();
    await type('far');
    await act(async () => void fireEvent.change(input(), { target: { value: '' } }));
    after();
  });

  it('stops saying Searching… when the field is left while the search is out', async () => {
    await opened();
    await type('far');
    await act(async () => void fireEvent.blur(input()));
    after();
  });

  it('stops saying Searching… when an entity already listed is chosen while the search is out', async () => {
    const reads = await opened();
    await type('acc');
    await press(within(field()).getByRole('option', { name: 'acc-1' }));
    after();
    expect(reads.calls[0]?.signal?.aborted).toBe(true);
  });
});
