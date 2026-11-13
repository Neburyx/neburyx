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
/** The sections of the list are all on screen: there is no tab to open, only the section to read. */
export const openTab = async (_name: RegExp | string): Promise<void> => {
  await settle();
};

const heading = (name: RegExp | string) => screen.getByRole('heading', { name }).textContent;
const section = (name: RegExp | string) => within(screen.getByRole('region', { name }));

describe('the list of the panel', () => {
  it('has the search, the three sections with their counts, the built-in rows with Run and no menu, and the footnote', async () => {
    await savedWorkspace();
    expect(screen.getByRole('searchbox', { name: 'Search patterns' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 3 }).map((entry) => entry.textContent)).toEqual(['Built-in · 3', 'My patterns · 0', 'Shared on this source · 0']);
    const builtIn = section(/Built-in/);
    expect(builtIn.getAllByRole('listitem')).toHaveLength(3);
    expect(builtIn.getByRole('button', { name: 'Run Shared devices' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^More:/ })).toBeNull();
    expect(screen.getByText('Shared patterns can be run or copied. Only their owner can change or delete them.')).toBeTruthy();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('puts a pattern of the person in My patterns and another person’s shared one in Shared, with a badge, the owner’s name and when the last run was', async () => {
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([MINE, THEIRS, listed({ id: '0192f000-0000-7000-8000-000000000003', name: 'Gamma', lastRunAt: '2026-11-10T08:00:00.000Z', visibility: 'shared' })]) } });
    expect(kit.patternCalls[0]?.args[0]).toEqual({ sourceId: 'a', limit: DEFAULT_PATTERN_LIST_LIMIT });
    expect(screen.getAllByRole('heading', { level: 3 }).map((entry) => entry.textContent)).toEqual(['Built-in · 3', 'My patterns · 2', 'Shared on this source · 1']);
    const mine = section(/My patterns/);
    expect(mine.getByText('Alpha')).toBeTruthy();
    expect(mine.getByText('Private')).toBeTruthy();
    expect(mine.getByText('Shared')).toBeTruthy();
    expect(mine.getByText(/Not run yet/)).toBeTruthy();
    expect(mine.getByText(/Last run 2026-11-10 UTC/)).toBeTruthy();
    expect(mine.queryByText('Beta')).toBeNull();
    const shared = section(/Shared on this source/);
    expect(shared.getByText('Beta')).toBeTruthy();
    expect(shared.getByText(/Not run yet · shared by Pat$/)).toBeTruthy();
  });

  it('says in each section with no rows that there are none, and starts the chain of a saved definition and of a built-in pattern with the start type', async () => {
    await savedWorkspace();
    expect(section(/My patterns/).getByText('You have no saved patterns. Choose New pattern to build one.')).toBeTruthy();
    expect(section(/Shared on this source/).getByText('Nobody has shared a pattern on this source.')).toBeTruthy();
    expect(section(/Built-in/).getAllByText(/→ USES →/)).toHaveLength(1);
  });

  it('filters the rows of each section on the client as the text is typed, says when none of a section matches, and sends nothing', async () => {
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([MINE, THEIRS]) } });
    const calls = kit.patternCalls.length;
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search patterns' }), 'alp');
    expect(section(/My patterns/).getByText('Alpha')).toBeTruthy();
    expect(section(/Shared on this source/).queryByText('Beta')).toBeNull();
    expect(section(/Shared on this source/).getByText('No pattern in this section matches the search.')).toBeTruthy();
    expect(section(/Built-in/).getByText('No pattern in this section matches the search.')).toBeTruthy();
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search patterns' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search patterns' }), 'USES');
    expect(section(/Built-in/).getAllByRole('listitem')).toHaveLength(1);
    expect(kit.patternCalls.length).toBe(calls);
  });

  it('says the search covers the rows loaded so far while more pages remain, and keeps Load more', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([MINE], 'next-1') } });
    expect(screen.queryByText('The search covers the patterns loaded so far.')).toBeNull();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search patterns' }), 'a');
    expect(screen.getByText('The search covers the patterns loaded so far.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();
  });

  it('offers the person’s own pattern its menu in order, with Delete last in the warning colour, and another person’s shared pattern Run and Copy and the owner-only lines that do nothing', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([MINE, THEIRS]) } });
    await userEvent.click(screen.getByRole('button', { name: 'More: Alpha' }));
    const own = within(screen.getByRole('menu', { name: 'Alpha' }));
    expect(own.getAllByRole('menuitem').map((entry) => entry.textContent)).toEqual(['Run', 'Change', 'Rename', 'Share', 'Copy', 'Delete']);
    expect(own.getByRole('menuitem', { name: 'Delete' }).className).toContain('pattern-menu-danger');
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'More: Beta' }));
    const theirs = within(screen.getByRole('menu', { name: 'Beta' }));
    expect(theirs.getAllByRole('menuitem').map((entry) => entry.textContent)).toEqual(['Run', 'Copy', 'Changeowner only', 'Renameowner only', 'Deleteowner only']);
    expect(theirs.getByText('Owned by Pat. Only the owner can:')).toBeTruthy();
    await userEvent.click(theirs.getByRole('menuitem', { name: /^Delete/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('menu', { name: 'Beta' })).toBeTruthy();
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
    expect(heading(/^My patterns/)).toBe('My patterns · ≥ 1 · lower bound');
    await openTab(/My patterns/);
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await settle();
    expect(asked[1]).toEqual({ sourceId: 'a', limit: DEFAULT_PATTERN_LIST_LIMIT, cursor: 'next-1' });
    expect(heading(/^My patterns/)).toBe('My patterns · 2');
    expect(screen.getByText('Delta')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('offers Load more and keeps the lower bound on a short page, even an empty one, while a cursor remains', async () => {
    await savedWorkspace({ patterns: { listPatterns: async (query) => (query.cursor === undefined ? page([MINE], 'next-1') : page([], 'next-2')) } });
    await openTab(/My patterns/);
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await settle();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();
    expect(heading(/^My patterns/)).toBe('My patterns · ≥ 1 · lower bound');
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
    expect(screen.getByText('The list changed while you were reading it, so it was read again from the start.')).toBeTruthy();
    expect(section(/My patterns/).getByText('Round 2')).toBeTruthy();
  });

  it('keeps the rows already read when Load more fails, and says why', async () => {
    await savedWorkspace({ patterns: { listPatterns: async (query) => (query.cursor === undefined ? page([MINE], 'next-1') : { ok: false, failure: failure('RATE_LIMITED', { retryAfterMs: 12000 }) }) } });
    await openTab(/My patterns/);
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await settle();
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('You can try again in 12 s.');
  });

  it('says why the saved list cannot be read with Retry, and the built-in rows keep working', async () => {
    let calls = 0;
    await savedWorkspace({ patterns: { listPatterns: async () => (++calls === 1 ? { ok: false, failure: failure('ACCESS_DENIED') } : page([MINE])) } });
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    expect(section(/Built-in/).getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
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
