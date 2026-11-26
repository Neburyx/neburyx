import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '@neburyx/contracts';
import { fakeClient } from '../../api/fake-client.js';
import { SEARCH_WAIT_MS } from '../../api/read-wait.js';
import { answerOf } from '../../search/search-test-kit.js';
import { drawn, end, ENDINGS, expectLine, held, press, timesSaid, wait } from '../../waiting-kit.js';
import { typedNode } from '../../workspace/filters-kit.js';
import { SEARCH_DEBOUNCE_MS } from '../start-entity.js';
import { StartChoice } from './start-choice.js';

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
  render(<StartChoice client={client} sourceId="a" sourceName="alpha" mask={false} typeName="kind-a" entityType="kind-a" candidates={[typedNode('acc-1', 'kind-a')]} chosen={undefined} onChoose={(node) => chosen.push(node.ref.stableId)} showIds inputId="start" />);
  return { reads, chosen };
}

const input = () => screen.getByRole('combobox') as HTMLInputElement;
const field = () => input().closest('.run-start') as HTMLElement;
const type = async (text: string) => {
  await act(async () => {
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: text } });
  });
  await wait(SEARCH_DEBOUNCE_MS);
};
const waiting = () => {
  expectLine(WORD, field());
  expect(field().getAttribute('aria-busy')).toBe('true');
  expect(input().disabled).toBe(false);
};
const after = () => {
  expect(timesSaid(WORD)).toBe(0);
  expect(field().getAttribute('aria-busy')).toBeNull();
};
const option = () => within(field()).getByRole('option', { name: /far-1/ });

describe('the start choice of a pattern run while the first search is out', () => {
  it('says Searching… once in a busy field', async () => {
    shown();
    await type('far');
    waiting();
  });

  it.each(ENDINGS)('is busy until the search ends, and stops on: %s', async (how) => {
    const { reads } = shown();
    await type('far');
    const busy = () => expect(field().getAttribute('aria-busy')).toBe('true');
    busy();
    await end(how, reads.calls[0], found, SEARCH_WAIT_MS, busy);
    after();
    if (how === 'answer') expect(option()).toBeTruthy();
    else expect(within(field()).getByRole('alert')).toBeTruthy();
  });
});

describe('the start choice of a pattern run while a later search is out', () => {
  it.each(ENDINGS)('says Searching… once with the earlier results listed and usable, and stops on: %s', async (how) => {
    const { reads, chosen } = shown();
    await type('far');
    await act(async () => reads.calls[0]?.settle({ ok: true, value: found }));
    await type('far-');
    const during = () => {
      waiting();
      expect(option().getAttribute('aria-disabled')).toBeNull();
    };
    during();
    await end(how, reads.calls[1], found, SEARCH_WAIT_MS, during);
    after();
    await press(option());
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
