import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '@neburyx/contracts';
import { fakeClient } from './api/fake-client.js';
import { StartChoice } from './patterns/run/start-choice.js';
import { SEARCH_DEBOUNCE_MS } from './patterns/start-entity.js';
import { answerOf } from './search/search-test-kit.js';
import { held, wait } from './waiting-kit.js';
import { typedNode } from './workspace/filters-kit.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const first = answerOf('a', [typedNode('far-1', 'kind-a')]);

describe('the rows a picker keeps while it waits or after a search fails', () => {
  async function searched() {
    const reads = held<SearchResult>();
    const client = fakeClient({ searchEntities: (_request, signal) => reads.read(signal) });
    const picker = (mask: boolean, sourceId = 'a') => <StartChoice client={client} sourceId={sourceId} sourceName="alpha" mask={mask} typeName="kind-a" entityType="kind-a" candidates={[]} chosen={undefined} onChoose={() => undefined} showIds inputId="start" />;
    const view = render(picker(false));
    await act(async () => {
      fireEvent.focus(screen.getByRole('combobox'));
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'far' } });
    });
    await wait(SEARCH_DEBOUNCE_MS);
    await act(async () => reads.calls[0]?.settle({ ok: true, value: first }));
    expect(screen.getByRole('option', { name: /far-1/ })).toBeTruthy();
    return { reads, view, picker };
  }

  it.each([
    ['masking is switched on', true, 'a'],
    ['the source changes', false, 'b'],
  ])('are none of the earlier ones once %s, at once, while the next search waits and after it fails', async (_name, mask, sourceId) => {
    const { reads, view, picker } = await searched();
    view.rerender(picker(mask, sourceId));
    expect(screen.queryByRole('option', { name: /far-1/ })).toBeNull();
    await wait(SEARCH_DEBOUNCE_MS);
    expect(screen.queryByRole('option', { name: /far-1/ })).toBeNull();
    await act(async () => reads.calls[1]?.settle({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }));
    expect(screen.queryByRole('option', { name: /far-1/ })).toBeNull();
  });

  it('stay, headed by the text they answered, while a newer search waits and after it fails', async () => {
    const { reads } = await searched();
    await act(async () => void fireEvent.change(screen.getByRole('combobox'), { target: { value: 'far-' } }));
    await wait(SEARCH_DEBOUNCE_MS);
    await act(async () => reads.calls[1]?.settle({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }));
    const list = screen.getByRole('listbox');
    expect(list.getAttribute('aria-label')).toContain('far');
    expect(list.getAttribute('aria-label')).not.toContain('far-');
    expect(screen.getByRole('option', { name: /far-1/ })).toBeTruthy();
  });
});
