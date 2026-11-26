import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '@neburyx/contracts';
import { fakeClient } from '../api/fake-client.js';
import { SEARCH_WAIT_MS } from '../api/read-wait.js';
import { answerOf } from '../search/search-test-kit.js';
import { drawn, end, ENDINGS, expectLine, held, press, timesSaid, wait } from '../waiting-kit.js';
import { typedNode } from '../workspace/filters-kit.js';
import { PATTERNS_COPY } from './copy.js';
import { SEARCH_DEBOUNCE_MS, StartEntityField } from './start-entity.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const WORD = 'Searching…';
const found = answerOf('a', [typedNode('far-1', 'kind-a')]);

function shown() {
  const reads = held<SearchResult>();
  const chosen: string[] = [];
  const client = fakeClient({ searchEntities: (_request, signal) => reads.read(signal) });
  render(<StartEntityField client={client} sourceId="a" mask={false} label="Starting account" entityType="kind-a" candidates={[typedNode('acc-1', 'kind-a')]} chosenKey={undefined} onChoose={(node) => chosen.push(node.ref.stableId)} selectRef={createRef<HTMLSelectElement>()} />);
  return { reads, chosen };
}

const select = () => screen.getByLabelText('Starting account') as HTMLSelectElement;
const field = () => select().closest('.patterns-field') as HTMLElement;
const search = () => screen.getByRole('searchbox', { name: PATTERNS_COPY.searchLabel });
const type = async (text: string) => {
  await act(async () => void fireEvent.change(search(), { target: { value: text } }));
  await wait(SEARCH_DEBOUNCE_MS);
};
const waiting = () => {
  expectLine(WORD, field());
  expect(field().getAttribute('aria-busy')).toBe('true');
  expect(select().disabled).toBe(false);
};
const after = () => {
  expect(timesSaid(WORD)).toBe(0);
  expect(field().getAttribute('aria-busy')).toBeNull();
};

describe('the start entity picker of a pattern while a search is out', () => {
  it.each(ENDINGS)('says Searching… once in a busy field, from the typing on, and stops on: %s', async (how) => {
    const { reads } = shown();
    await act(async () => void fireEvent.change(search(), { target: { value: 'far' } }));
    waiting();
    await wait(SEARCH_DEBOUNCE_MS);
    await end(how, reads.calls[0], found, SEARCH_WAIT_MS, waiting);
    after();
    if (how !== 'answer') expect(within(field()).getByRole('alert').textContent).toBe(PATTERNS_COPY.searchFailed);
  });

  it.each(ENDINGS)('keeps the earlier results listed and usable during the next search, and stops on: %s', async (how) => {
    const { reads, chosen } = shown();
    await type('far');
    await act(async () => reads.calls[0]?.settle({ ok: true, value: found }));
    await type('far-');
    const option = () => within(select()).getByRole('option', { name: 'far-1' }) as HTMLOptionElement;
    const during = () => {
      waiting();
      expect(option().disabled).toBe(false);
    };
    during();
    await end(how, reads.calls[1], found, SEARCH_WAIT_MS, during);
    after();
    await act(async () => void fireEvent.change(select(), { target: { value: option().value } }));
    expect(chosen).toEqual(['far-1']);
  });

  it('shows the wait in place of the failure while Try again searches', async () => {
    const { reads } = shown();
    await type('far');
    await end('failure', reads.calls[0], found, SEARCH_WAIT_MS, () => undefined);
    await press(within(field()).getByRole('button'));
    waiting();
    expect(within(field()).queryByRole('alert')).toBeNull();
    await wait(SEARCH_DEBOUNCE_MS + SEARCH_WAIT_MS);
    await drawn();
    after();
  });

  it('stops saying Searching… when the text is cleared while the search is out', async () => {
    shown();
    await type('far');
    await type('');
    after();
  });
});
