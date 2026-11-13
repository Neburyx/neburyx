import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { typedNode } from '../workspace/filters-kit.js';
import { openPatterns, patternsWorkspace, selectAccount, settle } from './patterns-kit.js';
import { searchOf } from './search-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const start = (): HTMLSelectElement => screen.getByLabelText('Starting account') as HTMLSelectElement;
const run = (): HTMLElement => screen.getByRole('button', { name: 'Run pattern' });
const optionTexts = (): string[] => within(start()).getAllByRole('option').map((option) => option.textContent ?? '');

describe('the starting entity', () => {
  it('lists the selected entities of the anchor type first, then the loaded ones, and no other type', async () => {
    const kit = await patternsWorkspace({ nodes: [typedNode('acc-1', 'kind-a'), typedNode('acc-2', 'kind-a'), typedNode('acc-3', 'kind-a'), typedNode('dev-1', 'kind-b')] });
    selectAccount(kit.state, 'acc-3');
    await openPatterns();
    expect(optionTexts()).toEqual(['Choose an entity', 'acc-3', 'acc-1', 'acc-2']);
  });

  it('sends the type and stable id of the chosen entity', async () => {
    const kit = await patternsWorkspace();
    await openPatterns();
    await userEvent.selectOptions(start(), 'acc-2');
    await userEvent.click(run());
    await settle();
    expect(kit.sent[0]?.request.params).toEqual({ ref: { entityType: 'kind-a', stableId: 'acc-2' } });
  });

  it('never sends typed text as the ref and leaves Run disabled with nothing chosen', async () => {
    const kit = await patternsWorkspace({ nodes: [typedNode('acc-1', 'kind-a'), typedNode('acc-2', 'kind-a')] });
    await openPatterns();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search the source' }), 'ACC-777');
    expect(run().hasAttribute('disabled')).toBe(true);
    expect(kit.sent).toHaveLength(0);
  });

  it('searches the source for the anchor type only, without type-ahead, and offers the hit', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const kit = await patternsWorkspace({ search: async () => searchOf([typedNode('acc-9', 'kind-a')]) as never });
    await openPatterns();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search the source' }), 'acc-9', { delay: null });
    await act(async () => void (await vi.advanceTimersByTimeAsync(400)));
    expect(kit.searches.at(-1)).toEqual({ sourceId: 'a', text: 'acc-9', entityTypes: ['kind-a'] });
    expect(optionTexts()).toContain('acc-9');
    await userEvent.selectOptions(start(), 'acc-9');
    await userEvent.click(run());
    await settle();
    expect(kit.sent[0]?.request.params).toEqual({ ref: { entityType: 'kind-a', stableId: 'acc-9' } });
  });

  it('says so for an empty search and for a failed one, and keeps the list', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fail = false;
    await patternsWorkspace({ search: async () => (fail ? ({ ok: false, failure: { code: 'SOURCE_BUSY' } } as never) : (searchOf([]) as never)) });
    await openPatterns();
    const box = screen.getByRole('searchbox', { name: 'Search the source' });
    await userEvent.type(box, 'zz', { delay: null });
    await act(async () => void (await vi.advanceTimersByTimeAsync(400)));
    expect(screen.getByText('Nothing found.')).toBeTruthy();
    fail = true;
    await userEvent.type(box, 'y', { delay: null });
    await act(async () => void (await vi.advanceTimersByTimeAsync(400)));
    expect(screen.getByText('The search failed.')).toBeTruthy();
    expect(optionTexts()).toContain('acc-1');
  });

  it('says the search failed when the call itself throws, and keeps the list', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await patternsWorkspace({ search: () => Promise.reject(new Error('down')) });
    await openPatterns();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search the source' }), 'zz', { delay: null });
    await act(async () => void (await vi.advanceTimersByTimeAsync(400)));
    expect(screen.getByText('The search failed.')).toBeTruthy();
    expect(optionTexts()).toContain('acc-1');
  });

  it('follows a single selection while empty, and keeps the person’s own choice', async () => {
    const kit = await patternsWorkspace();
    await openPatterns();
    selectAccount(kit.state, 'acc-1');
    expect(start().value).toContain('acc-1');
    await userEvent.selectOptions(start(), 'acc-2');
    selectAccount(kit.state, 'acc-1');
    expect(start().value).toContain('acc-2');
  });
});
