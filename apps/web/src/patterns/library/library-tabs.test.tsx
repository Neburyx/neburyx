import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { testProfile } from '../../dev/test-profile.js';
import { failure, listOf } from '../patterns-kit.js';
import { libraryPage, listed, page, settle, tab, tableRows, withDefinition } from './library-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const MINE = listed({ id: '0192f000-0000-7000-8000-000000000001', name: 'Alpha' });
const THEIRS = listed({ id: '0192f000-0000-7000-8000-000000000003', name: 'Beta', ownedByYou: false, visibility: 'shared', owner: { name: 'Pat' } });
const RETIRED = listed({ id: '0192f000-0000-7000-8000-000000000004', name: 'Retired', availability: { status: 'unavailable', reasons: [{ code: 'unknown-entity-type', path: ['steps', 0, 'arrivesAt'] }] } });

describe('the tabs of the library', () => {
  it('holds My patterns, Shared with me and Built-in with their counts, and no Alerts tab', async () => {
    await libraryPage({ templates: async () => ({ ok: true, value: withDefinition() }), patterns: { listPatterns: async () => page([MINE, THEIRS]) } });
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual(['My patterns · 1', 'Shared with me · 1', 'Built-in · 4']);
    expect(screen.queryByText(/Alerts/)).toBeNull();
    expect(tab(/^My patterns/).getAttribute('aria-selected')).toBe('true');
  });

  it('lists the shared tab’s rows with their owner and the footnote about what only the owner can do, and says nobody has shared one when none is', async () => {
    await libraryPage({ patterns: { listPatterns: async () => page([MINE, THEIRS]) } });
    await userEvent.click(tab(/^Shared with me/));
    expect(tableRows()[0]).toContain('Shared by Pat');
    expect(screen.getByText('Shared patterns can be run or copied. Only their owner can change or delete them.')).toBeTruthy();
    cleanup();
    await libraryPage({ patterns: { listPatterns: async () => page([MINE]) } });
    await userEvent.click(tab(/^Shared with me/));
    expect(screen.getByText('Nobody has shared a pattern on this source.')).toBeTruthy();
  });

  it('lists the built-in patterns without a menu and a built-in definition with Run and Copy in its menu, in the sections the panel names: each group, then the general section', async () => {
    await libraryPage({ templates: async () => ({ ok: true, value: withDefinition() }) });
    await userEvent.click(tab(/^Built-in/));
    const named = within(screen.getByRole('region', { name: 'Built-in · AML typologies' }));
    const general = within(screen.getByRole('region', { name: 'Built-in · general' }));
    expect(named.getAllByRole('row').slice(1).map((row) => row.textContent?.slice(0, 11))).toEqual(['Fan-outOne ']);
    expect(general.getAllByRole('row').slice(1).map((row) => row.textContent?.slice(0, 12))).toEqual(['Shared devic', 'Shared addre', 'Connected ac']);
    expect(screen.queryByRole('button', { name: 'More: Shared devices' })).toBeNull();
    expect(general.getAllByRole('row')[1]?.textContent).toContain('Built in');
    await userEvent.click(screen.getByRole('button', { name: 'More: Fan-out' }));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Run', 'Copy']);
  });

  it('puts the definitions of several groups and of no group in their own sections, with the built-in patterns in the general one', async () => {
    const base = withDefinition();
    const first = base.builtInDefinitions?.[0];
    if (first === undefined) throw new Error('no definition');
    const more = { ...base, builtInDefinitions: [first, { ...first, id: 'two', name: 'Two', group: 'Other group' }, { ...first, id: 'free', name: 'Free', group: undefined }] };
    await libraryPage({ templates: async () => ({ ok: true, value: more }) });
    await userEvent.click(tab(/^Built-in/));
    expect(screen.getAllByRole('region').map((region) => region.getAttribute('aria-label')).filter((name) => name?.startsWith('Built-in'))).toEqual(['Built-in · AML typologies', 'Built-in · Other group', 'Built-in · general']);
    expect(within(screen.getByRole('region', { name: 'Built-in · general' })).getAllByRole('row').slice(1)).toHaveLength(4);
  });

  it('points each tab at the panel it controls, and the panel at its tab', async () => {
    await libraryPage({ patterns: { listPatterns: async () => page([MINE, THEIRS]) } });
    for (const name of [/^My patterns/, /^Shared with me/, /^Built-in/]) {
      await userEvent.click(tab(name));
      const controlled = document.getElementById(tab(name).getAttribute('aria-controls') ?? '');
      expect(controlled).toBe(screen.getByRole('tabpanel'));
    }
  });

  it('says what is missing when the templates or the profile cannot be read, keeps the rows, and reads them again on Try again', async () => {
    let templateAnswers = false;
    let profileAnswers = false;
    await libraryPage({
      templates: async () => (templateAnswers ? { ok: true, value: listOf() } : { ok: false, failure: failure('SOURCE_UNAVAILABLE') }),
      profile: async () => (profileAnswers ? { ok: true, value: testProfile('a') } : { ok: false, failure: failure('SOURCE_UNAVAILABLE') }),
      patterns: { listPatterns: async () => page([MINE]) },
    });
    expect(screen.getByText(/Some names could not be read/)).toBeTruthy();
    expect(tableRows()).toHaveLength(1);
    templateAnswers = true;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(screen.getByText(/Some names could not be read/)).toBeTruthy();
    profileAnswers = true;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(screen.queryByText(/Some names could not be read/)).toBeNull();
    expect(tableRows()).toHaveLength(1);
  });

  it('says a template list that cannot be read on the Built-in tab, with Try again', async () => {
    let answers = false;
    await libraryPage({ templates: async () => (answers ? { ok: true, value: listOf() } : { ok: false, failure: failure('SOURCE_UNAVAILABLE') }) });
    await userEvent.click(tab(/^Built-in/));
    answers = true;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
  });

  it('says a partially read list has nothing for the tab yet, and not a failed search, while a cursor remains', async () => {
    await libraryPage({ patterns: { listPatterns: async () => page([MINE], 'c1') } });
    await userEvent.click(tab(/^Shared with me/));
    expect(screen.getByText('None of the patterns loaded so far belongs in this tab. Load more to read further.')).toBeTruthy();
    expect(screen.queryByText('No pattern in this tab matches the search.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();
  });

  it('says the source has no built-in patterns when the list holds none', async () => {
    await libraryPage({ templates: async () => ({ ok: true, value: listOf([]) }) });
    await userEvent.click(tab(/^Built-in/));
    expect(screen.getByText('This source has no built-in patterns.')).toBeTruthy();
  });

  it('carries the unavailable flag and its reason on a row, with Run off', async () => {
    await libraryPage({ patterns: { listPatterns: async () => page([RETIRED]) } });
    const row = within(screen.getByRole('row', { name: /Retired/ }));
    expect(row.getByText('Unavailable')).toBeTruthy();
    expect(row.getByText(/uses a type the mapping no longer has/)).toBeTruthy();
    expect(row.getByRole('button', { name: 'Run Retired' })).toHaveProperty('disabled', true);
  });

  it('follows the tabs pattern: the arrow keys, Home and End move the choice and the focus, only the chosen tab is in the Tab order, and the panel is named by it', async () => {
    await libraryPage({ patterns: { listPatterns: async () => page([MINE, THEIRS]) } });
    tab(/^My patterns/).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(tab(/^Shared with me/));
    expect(tab(/^Shared with me/).getAttribute('aria-selected')).toBe('true');
    expect(tab(/^My patterns/).getAttribute('tabindex')).toBe('-1');
    expect(screen.getByRole('tabpanel').getAttribute('aria-label')).toMatch(/^Shared with me/);
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(tab(/^Built-in/));
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(tab(/^My patterns/));
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(tab(/^Built-in/));
    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(tab(/^My patterns/));
  });
});
