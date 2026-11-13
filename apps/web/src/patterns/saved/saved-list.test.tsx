import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_PATTERN_LIST_LIMIT, type ListedPattern } from '@neburyx/contracts';
import type { ApiResult } from '../../api/client.js';
import type { PatternListResponse } from '@neburyx/contracts';
import { failure, listed, openPatterns, patternsWorkspace, settle, type KitOptions } from '../patterns-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const page = (items: readonly ListedPattern[], nextCursor: string | null = null): ApiResult<PatternListResponse> => ({ ok: true, value: { items: [...items], nextCursor } });
const MINE = listed({ id: '0192f000-0000-7000-8000-000000000001', name: 'Alpha' });
const THEIRS = listed({ id: '0192f000-0000-7000-8000-000000000002', name: 'Beta', ownedByYou: false, visibility: 'shared', owner: { name: 'Pat' } });

export async function savedWorkspace(options: KitOptions = {}) {
  const kit = await patternsWorkspace(options);
  await openPatterns();
  return kit;
}
export const tab = (name: RegExp | string) => screen.getByRole('tab', { name });
export const openTab = async (name: RegExp | string): Promise<void> => {
  await userEvent.click(tab(name));
  await settle();
};

describe('the tabs of the panel', () => {
  it('has three tabs, Built-in selected and holding the presets, with no menu on a preset', async () => {
    await savedWorkspace();
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual(['My patterns · 0', 'Shared on this source · 0', 'Built-in · 3']);
    expect(tab(/Built-in/).getAttribute('aria-selected')).toBe('true');
    const presets = within(screen.getByRole('radiogroup', { name: 'Patterns' })).getAllByRole('radio');
    expect(presets).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /^More:/ })).toBeNull();
  });

  it('puts a pattern of the person in My patterns and another person’s shared one in Shared, with the owner’s name, when the last run was and the visibility', async () => {
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([MINE, THEIRS, listed({ id: '0192f000-0000-7000-8000-000000000003', name: 'Gamma', lastRunAt: '2026-11-10T08:00:00.000Z', visibility: 'shared' })]) } });
    expect(kit.patternCalls[0]?.args[0]).toEqual({ sourceId: 'a', limit: DEFAULT_PATTERN_LIST_LIMIT });
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual(['My patterns · 2', 'Shared on this source · 1', 'Built-in · 3']);
    await openTab(/My patterns/);
    const mine = within(screen.getByRole('tabpanel', { name: /My patterns/ }));
    expect(mine.getByText('Alpha')).toBeTruthy();
    expect(mine.getByText('Not run yet · Only me')).toBeTruthy();
    expect(mine.getByText('Last run 2026-11-10 UTC · Everyone on this source')).toBeTruthy();
    expect(mine.queryByText('Beta')).toBeNull();
    await openTab(/Shared on this source/);
    const shared = within(screen.getByRole('tabpanel', { name: /Shared on this source/ }));
    expect(shared.getByText('Beta')).toBeTruthy();
    expect(shared.getByText('Not run yet · Everyone on this source · Pat')).toBeTruthy();
  });

  it('shows the footnote under the saved tabs, and a sentence for an empty tab', async () => {
    await savedWorkspace();
    await openTab(/My patterns/);
    const mine = within(screen.getByRole('tabpanel', { name: /My patterns/ }));
    expect(mine.getByText('You have no saved patterns. Choose New pattern to build one.')).toBeTruthy();
    expect(mine.getByText(/never query text/)).toBeTruthy();
    await openTab(/Shared on this source/);
    expect(within(screen.getByRole('tabpanel', { name: /Shared on this source/ })).getByText('Nobody has shared a pattern on this source.')).toBeTruthy();
  });

  it('moves between the tabs with the arrow keys, Home and End', async () => {
    await savedWorkspace();
    tab(/Built-in/).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(tab(/My patterns/).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab(/My patterns/));
    await userEvent.keyboard('{End}');
    expect(tab(/Built-in/).getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{Home}');
    expect(tab(/My patterns/).getAttribute('aria-selected')).toBe('true');
  });
});

describe('reading the list a page at a time', () => {
  it('counts a lower bound while a cursor remains, loads the next page with it, and counts the rows once the list is whole', async () => {
    const asked: Array<{ cursor?: string }> = [];
    await savedWorkspace({
      patterns: {
        listPatterns: async (query) => {
          asked.push(query);
          return query.cursor === undefined ? page([MINE], 'next-1') : page([listed({ id: '0192f000-0000-7000-8000-000000000009', name: 'Delta' })]);
        },
      },
    });
    expect(tab(/My patterns/).textContent).toBe('My patterns · ≥ 1 · lower bound');
    await openTab(/My patterns/);
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await settle();
    expect(asked[1]).toEqual({ sourceId: 'a', limit: DEFAULT_PATTERN_LIST_LIMIT, cursor: 'next-1' });
    expect(tab(/My patterns/).textContent).toBe('My patterns · 2');
    expect(screen.getByText('Delta')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('offers Load more and keeps the lower bound on a short page, even an empty one, while a cursor remains', async () => {
    await savedWorkspace({ patterns: { listPatterns: async (query) => (query.cursor === undefined ? page([MINE], 'next-1') : page([], 'next-2')) } });
    await openTab(/My patterns/);
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await settle();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();
    expect(tab(/My patterns/).textContent).toBe('My patterns · ≥ 1 · lower bound');
  });

  it('reads the list again from its first page, and says so, when a cursor is refused', async () => {
    let first = 0;
    const asked: Array<{ cursor?: string }> = [];
    await savedWorkspace({
      patterns: {
        listPatterns: async (query) => {
          asked.push(query);
          if (query.cursor !== undefined) return { ok: false, failure: failure('CURSOR_INVALIDATED') };
          return page([listed({ id: '0192f000-0000-7000-8000-00000000000a', name: `Round ${++first}` })], 'next-1');
        },
      },
    });
    await openTab(/My patterns/);
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await settle();
    expect(asked.map((query) => query.cursor)).toEqual([undefined, 'next-1', undefined]);
    const mine = within(screen.getByRole('tabpanel', { name: /My patterns/ }));
    expect(mine.getByText('The list changed while you were reading it, so it was read again from the start.')).toBeTruthy();
    expect(mine.getByText('Round 2')).toBeTruthy();
  });

  it('keeps the rows already read when Load more fails, and says why', async () => {
    await savedWorkspace({ patterns: { listPatterns: async (query) => (query.cursor === undefined ? page([MINE], 'next-1') : { ok: false, failure: failure('RATE_LIMITED', { retryAfterMs: 12000 }) }) } });
    await openTab(/My patterns/);
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await settle();
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('You can try again in 12 s.');
  });

  it('says why the list cannot be read in the saved tabs with Retry, and the Built-in tab keeps working', async () => {
    let calls = 0;
    await savedWorkspace({ patterns: { listPatterns: async () => (++calls === 1 ? { ok: false, failure: failure('ACCESS_DENIED') } : page([MINE])) } });
    await openTab(/My patterns/);
    expect(within(screen.getByRole('tabpanel', { name: /My patterns/ })).getByRole('alert')).toBeTruthy();
    await openTab(/Built-in/);
    expect(within(screen.getByRole('radiogroup', { name: 'Patterns' })).getAllByRole('radio')).toHaveLength(3);
    await openTab(/My patterns/);
    fireEvent.click(within(screen.getByRole('tabpanel', { name: /My patterns/ })).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(screen.getByText('Alpha')).toBeTruthy();
  });

  it('shows nothing of the old source’s rows after the source changes', async () => {
    let release: (answer: ApiResult<PatternListResponse>) => void = () => undefined;
    let calls = 0;
    const kit = await savedWorkspace({ patterns: { listPatterns: () => (++calls === 1 ? new Promise((resolve) => (release = resolve)) : Promise.resolve(page([]))) } });
    act(() => kit.state.bindSource('b'));
    await settle();
    act(() => release(page([MINE])));
    await settle();
    expect(screen.queryByText('Alpha')).toBeNull();
  });
});
