import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { failure } from '../patterns-kit.js';
import { source } from '../../test-utils.js';
import { libraryPage, listed, page, settle, tab, tableRows } from './library-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const NOW = Date.now();
const MINUTES_AGO = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const MINE = listed({ id: '0192f000-0000-7000-8000-000000000001', name: 'Alpha' });
const RUN = listed({ id: '0192f000-0000-7000-8000-000000000002', name: 'Devices week', kind: 'preset-run', presetId: 'shared-devices', templateId: 'shared-attribute', templateVersion: 1, params: { window: { from: '2026-10-21', to: '2026-10-28' }, limit: 25 }, lastRunAt: MINUTES_AGO(12), visibility: 'shared' });
const THEIRS = listed({ id: '0192f000-0000-7000-8000-000000000003', name: 'Beta', ownedByYou: false, visibility: 'shared', owner: { name: 'Pat' } });

describe('the patterns library page', () => {
  it('shows the heading, the description, the footnote, the tabs and a table with its columns and a Run and a menu button for each row', async () => {
    await libraryPage({ patterns: { listPatterns: async () => page([MINE]) } });
    expect(screen.getByRole('heading', { name: 'Patterns', level: 1 })).toBeTruthy();
    expect(screen.getByText('Approved ways to explore. Save a run with its parameters to reuse or share it.')).toBeTruthy();
    expect(screen.getByText('A saved pattern stores the pattern and its parameters, never query text. Running it applies your own access and limits.')).toBeTruthy();
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual(['My patterns · 1', 'Shared with me · 0', 'Built-in · 3']);
    expect(screen.getAllByRole('columnheader').map((entry) => entry.textContent)).toEqual(['Name', 'Pattern', 'Parameters', 'Last run', 'Visibility', 'Actions']);
    const row = within(screen.getByRole('row', { name: /Alpha/ }));
    expect(row.getByRole('button', { name: 'Run Alpha' })).toBeTruthy();
    expect(row.getByRole('button', { name: 'More: Alpha' })).toBeTruthy();
  });

  it('writes the pattern, its parameters, its last run and its visibility in each row: a saved built-in run with its pattern name and the values of its stored parameters, a pattern built in the app by its steps', async () => {
    await libraryPage({ patterns: { listPatterns: async () => page([MINE, RUN]) } });
    const rows = tableRows();
    expect(rows[0]).toContain('Built in the app');
    expect(rows[0]).toContain('Not run yet');
    expect(rows[0]).toContain('Only me');
    expect(rows[1]).toContain('Devices week');
    expect(rows[1]).toContain('Shared devices');
    expect(rows[1]).not.toContain('v1');
    expect(rows[1]).toContain('21–28 Oct 2026 · max 25');
    expect(rows[1]).toContain('12 min ago');
    expect(rows[1]).toContain('Everyone on this source');
  });

  it('keeps the person’s own shared pattern under My patterns, and another person’s under the shared tab', async () => {
    await libraryPage({ patterns: { listPatterns: async () => page([RUN, THEIRS]) } });
    expect(tab(/^My patterns · 1/)).toBeTruthy();
    expect(tableRows()).toHaveLength(1);
    expect(tableRows()[0]).toContain('Devices week');
    await userEvent.click(tab(/^Shared with me · 1/));
    expect(tableRows()[0]).toContain('Beta');
    expect(tableRows()[0]).toContain('Shared by Pat');
  });

  it('labels the count as a lower bound while a cursor remains, and Load more reads the next page', async () => {
    let reads = 0;
    const kit = await libraryPage({ patterns: { listPatterns: async () => (++reads === 1 ? page([MINE], 'c1') : page([RUN], null)) } });
    expect(tab(/^My patterns/).textContent).toBe('My patterns · ≥ 1 · lower bound');
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await settle();
    expect(kit.queries.map((query) => query.cursor)).toEqual([undefined, 'c1']);
    expect(tab(/^My patterns/).textContent).toBe('My patterns · 2');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('says a list that cannot be read in words with Try again, and keeps the heading, the tabs and the footnote', async () => {
    let answer = false;
    await libraryPage({ patterns: { listPatterns: async () => (answer ? page([MINE]) : { ok: false, failure: failure('SOURCE_UNAVAILABLE') }) } });
    expect(screen.getByRole('heading', { name: 'Patterns', level: 1 })).toBeTruthy();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByText(/^A saved pattern stores/)).toBeTruthy();
    answer = true;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(tableRows()).toHaveLength(1);
  });

  it('keeps the rows already read with the sentence when Load more is refused, and reads the list again from the first page when the cursor is no longer valid', async () => {
    let step = 0;
    const kit = await libraryPage({
      patterns: {
        listPatterns: async () => {
          step += 1;
          if (step === 1) return page([MINE], 'c1');
          if (step === 2) return { ok: false, failure: failure('SOURCE_BUSY') };
          if (step === 3) return { ok: false, failure: failure('CURSOR_INVALIDATED') };
          return page([MINE, RUN], null);
        },
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await settle();
    expect(tableRows()).toHaveLength(1);
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await settle();
    expect(screen.getByText(/read again from the start/)).toBeTruthy();
    expect(tableRows()).toHaveLength(2);
    expect(kit.calls.filter((call) => call.method === 'listPatterns')).toHaveLength(4);
  });

  it('shows no answer of a source that was left while its read was on its way', async () => {
    let release: (value: ReturnType<typeof page>) => void = () => undefined;
    const kit = await libraryPage({
      path: '/patterns?source=a',
      sources: [source('a'), source('b')],
      patterns: {
        listPatterns: async (query) => (query.sourceId === 'a' ? new Promise((resolve) => (release = resolve)) : page([RUN])),
      },
    });
    await act(async () => {
      await kit.router.navigate('/patterns?source=b');
    });
    await settle();
    expect(tableRows()[0]).toContain('Devices week');
    release(page([MINE]));
    await settle();
    expect(tableRows()).toHaveLength(1);
    expect(tableRows()[0]).toContain('Devices week');
  });

  it('tags a synthetic source beside the heading and shows no line about the source', async () => {
    await libraryPage({ sources: [source('a', { synthetic: true })], patterns: { listPatterns: async () => page([MINE]) } });
    expect(document.querySelector('.page-tag')?.textContent).toBe('Synthetic data');
    expect(screen.queryByText(/ · read-only$/)).toBeNull();
  });

  it('shows no tag for a source that is not synthetic', async () => {
    await libraryPage({ sources: [source('a', { synthetic: false })], patterns: { listPatterns: async () => page([MINE]) } });
    expect(document.querySelector('.page-tag')).toBeNull();
  });

  it('has no search box above the tabs, writes the visibility as a pill and puts the footnote inside the table card', async () => {
    await libraryPage({ patterns: { listPatterns: async () => page([MINE, RUN]) } });
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.getByText('Everyone on this source').className).toBe('library-pill');
    expect(screen.getByRole('tabpanel').contains(screen.getByText(/never query text/))).toBe(true);
  });
});

describe('the source of the page', () => {
  it('lists the source the link names, and says so when it is not configured', async () => {
    await libraryPage({ path: '/patterns?source=b', sources: [source('a'), source('b', { alias: 'Bravo' })], patterns: { listPatterns: async (query) => page(query.sourceId === 'b' ? [RUN] : [MINE]) } });
    expect(tableRows()[0]).toContain('Devices week');
    expect(tableRows()[0]).toContain('Devices week');
    cleanup();
    await libraryPage({ path: '/patterns?source=zzz', sources: [source('a'), source('b')] });
    expect(screen.getByRole('alert').textContent).toBe('The source “zzz” is not configured.');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('asks for the source first when there are several and none is named or bound, reads nothing until it is chosen, and lists it once chosen with the keyboard', async () => {
    const kit = await libraryPage({ sources: [source('a'), source('b')], patterns: { listPatterns: async () => page([MINE]) } });
    expect(kit.calls).toHaveLength(0);
    expect(screen.queryByRole('tab')).toBeNull();
    const choice = screen.getByRole('combobox', { name: 'Source' });
    choice.focus();
    await userEvent.selectOptions(choice, 'b');
    await settle();
    expect(kit.calls.filter((call) => call.method === 'listPatterns')).toHaveLength(1);
    expect(tableRows()).toHaveLength(1);
  });

  it('says there is nothing to show when no source is configured', async () => {
    await libraryPage({ sources: [] });
    expect(screen.getByText('No source is configured, so there are no patterns to show.')).toBeTruthy();
  });

  it('reaches the page in the order of the sidebar, the chosen tab and the controls of each row, and the source control first when a source is to be chosen', async () => {
    await libraryPage({ patterns: { listPatterns: async () => page([MINE, RUN], 'c1') } });
    const seen: string[] = [];
    for (let presses = 0; presses < 13; presses += 1) {
      await userEvent.tab();
      const active = document.activeElement;
      seen.push(active?.getAttribute('aria-label') ?? active?.textContent ?? '');
    }
    const at = (text: string): number => seen.findIndex((entry) => entry.startsWith(text));
    expect(at('My patterns')).toBeGreaterThan(at('Sources'));
    expect(at('Run Alpha')).toBeGreaterThan(at('My patterns'));
    expect(at('More: Alpha')).toBe(at('Run Alpha') + 1);
    expect(at('Run Devices week')).toBe(at('More: Alpha') + 1);
    expect(at('Load more')).toBeGreaterThan(at('More: Devices week'));
    cleanup();
    await libraryPage({ sources: [source('a'), source('b')] });
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    expect(screen.getAllByRole('combobox', { name: 'Source' }).some((entry) => entry === document.activeElement)).toBe(true);
  });
});
