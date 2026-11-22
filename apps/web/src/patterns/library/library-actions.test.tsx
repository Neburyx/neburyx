import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { savedPatternSchema, type SavedPattern } from '@neburyx/contracts';
import { failure } from '../patterns-kit.js';
import { libraryPage, listed, page, settle, tab, tableRows, withDefinition } from './library-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const ID = '0192f000-0000-7000-8000-000000000001';
const OWN = listed({ id: ID, name: 'Alpha', version: 3 });
const RUN = listed({ id: '0192f000-0000-7000-8000-000000000002', name: 'Devices week', kind: 'preset-run', presetId: 'shared-devices', templateId: 'shared-attribute', templateVersion: 1, params: {} });
const THEIRS = listed({ id: '0192f000-0000-7000-8000-000000000003', name: 'Beta', ownedByYou: false, visibility: 'shared', owner: { name: 'Pat' } });
const stored = (overrides: Record<string, unknown> = {}): SavedPattern => savedPatternSchema.parse({ id: ID, sourceId: 'a', name: 'Alpha', askForStartingEntity: false, anchor: null, visibility: 'private', lastRunAt: null, createdAt: '2026-11-12T10:00:00.000Z', updatedAt: '2026-11-12T10:00:00.000Z', version: 4, kind: 'definition', definition: {}, ...overrides });
const menuOf = (name: string): HTMLElement => screen.getByRole('button', { name: `More: ${name}` });
const items = (): string[] => within(screen.getByRole('menu')).getAllByRole('menuitem').map((entry) => entry.textContent ?? '');
const choose = async (name: string): Promise<void> => {
  await userEvent.click(screen.getByRole('menuitem', { name }));
  await settle();
};
const calls = (kit: Awaited<ReturnType<typeof libraryPage>>, method: string) => kit.calls.filter((call) => call.method === method);

describe('the menu of a row on the page', () => {
  it('offers a pattern built in the app Run, Change, Rename, Share, Copy and Delete, a saved built-in run the same without Change, and another person’s pattern Run and Copy with the owner-only lines', async () => {
    await libraryPage({ patterns: { listPatterns: async () => page([OWN, RUN, THEIRS]) } });
    await userEvent.click(menuOf('Alpha'));
    expect(items()).toEqual(['Run', 'Change', 'Rename', 'Share', 'Copy', 'Delete']);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(menuOf('Devices week'));
    expect(items()).toEqual(['Run', 'Rename', 'Share', 'Copy', 'Delete']);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(tab(/^Shared with me/));
    await userEvent.click(menuOf('Beta'));
    expect(items()).toEqual(['Run', 'Copy', 'Changeowner only', 'Renameowner only', 'Deleteowner only']);
  });

  it('opens with Enter, moves with the arrow keys, closes with Escape and gives the focus back to its button', async () => {
    await libraryPage({ patterns: { listPatterns: async () => page([OWN]) } });
    menuOf('Alpha').focus();
    await userEvent.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0]);
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[1]);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(menuOf('Alpha'));
  });
});

describe('the actions of a saved row on the page', () => {
  it('keeps the rename dialog and the typed name when the name is already used, and reads the list again only after a change', async () => {
    const kit = await libraryPage({ patterns: { listPatterns: async () => page([OWN]), changePattern: async () => ({ ok: false, failure: failure('CONFLICT', { reason: 'pattern-name-taken' }) }) } });
    await userEvent.click(menuOf('Alpha'));
    await choose('Rename');
    const field = screen.getByLabelText('Name');
    await userEvent.clear(field);
    await userEvent.type(field, 'Beta');
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await settle();
    expect(field).toHaveProperty('value', 'Beta');
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe('This name is already used on this source. Choose another.');
    expect(calls(kit, 'listPatterns')).toHaveLength(1);
  });

  it('renames, copies, shares, unshares and deletes with the sentences and the version of the panel, and reads the list again after each', async () => {
    const kit = await libraryPage({
      patterns: {
        listPatterns: async () => page([OWN, listed({ id: '0192f000-0000-7000-8000-000000000009', name: 'Open', visibility: 'shared', version: 7 })]),
        changePattern: async () => ({ ok: true, value: stored() }),
        copyPattern: async () => ({ ok: true, value: stored({ id: '0192f000-0000-7000-8000-0000000000c1', name: 'Alpha (copy)' }) }),
        deletePattern: async () => ({ ok: true, value: { id: ID, version: 4, deletedAt: '2026-11-12T10:00:00.000Z', purgeAfter: '2026-12-12T10:00:00.000Z' } }),
      },
    });
    await userEvent.click(menuOf('Alpha'));
    await choose('Rename');
    const field = screen.getByLabelText('Name');
    await userEvent.clear(field);
    await userEvent.type(field, 'Omega');
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await settle();
    expect(calls(kit, 'changePattern')[0]?.args.slice(0, 2)).toEqual([ID, { expectedVersion: 3, name: 'Omega' }]);
    expect(screen.getByText('Pattern renamed.')).toBeTruthy();
    await userEvent.click(menuOf('Alpha'));
    await choose('Copy');
    expect(calls(kit, 'copyPattern')[0]?.args[0]).toBe(ID);
    expect(screen.getByText('Pattern copied.')).toBeTruthy();
    await userEvent.click(menuOf('Alpha'));
    await choose('Share');
    expect(screen.getByRole('heading', { name: 'Share this pattern?' })).toBeTruthy();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Share/ }));
    await settle();
    expect(calls(kit, 'changePattern')[1]?.args.slice(0, 2)).toEqual([ID, { expectedVersion: 3, visibility: 'shared' }]);
    await userEvent.click(menuOf('Open'));
    await choose('Unshare');
    expect(calls(kit, 'changePattern')[2]?.args.slice(0, 2)).toEqual(['0192f000-0000-7000-8000-000000000009', { expectedVersion: 7, visibility: 'private' }]);
    await userEvent.click(menuOf('Alpha'));
    await choose('Delete');
    expect(screen.getByText('This pattern is private to you. It is removed from My patterns and cannot be recovered.')).toBeTruthy();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete pattern' }));
    await settle();
    expect(calls(kit, 'deletePattern')[0]?.args.slice(0, 2)).toEqual([ID, 3]);
    expect(calls(kit, 'listPatterns').length).toBeGreaterThanOrEqual(6);
  });

  it.each([
    ['CONFLICT', /changed since you read the list/],
    ['NOT_FOUND', /not there any more/],
  ])('says %s in words, reads the list again and overwrites nothing', async (code, sentence) => {
    const kit = await libraryPage({ patterns: { listPatterns: async () => page([OWN]), changePattern: async () => ({ ok: false, failure: failure(code) }) } });
    await userEvent.click(menuOf('Alpha'));
    await choose('Rename');
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await settle();
    expect(screen.getByText(sentence)).toBeTruthy();
    expect(calls(kit, 'listPatterns')).toHaveLength(2);
  });

  it('hides the controls of a row after ACCESS_DENIED, when the list read again says it is not the person’s', async () => {
    let reads = 0;
    await libraryPage({
      patterns: {
        listPatterns: async () => page([++reads === 1 ? OWN : listed({ id: ID, name: 'Alpha', ownedByYou: false, visibility: 'shared', owner: { name: 'Pat' } })]),
        deletePattern: async () => ({ ok: false, failure: failure('ACCESS_DENIED') }),
      },
    });
    await userEvent.click(menuOf('Alpha'));
    await choose('Delete');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete pattern' }));
    await settle();
    await userEvent.click(tab(/^Shared with me/));
    await userEvent.click(menuOf('Alpha'));
    expect(items()).toEqual(['Run', 'Copy', 'Changeowner only', 'Renameowner only', 'Deleteowner only']);
  });

  it('keeps an own pattern under My patterns when it is shared and unshared, with the counts of the list read again', async () => {
    let visibility: 'private' | 'shared' = 'private';
    await libraryPage({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha', visibility })]), changePattern: async () => ((visibility = 'shared'), { ok: true, value: stored() }) } });
    expect(tab(/^My patterns · 1/)).toBeTruthy();
    await userEvent.click(menuOf('Alpha'));
    await choose('Share');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Share/ }));
    await settle();
    expect(tab(/^My patterns · 1/)).toBeTruthy();
    expect(tab(/^Shared with me · 0/)).toBeTruthy();
    expect(tableRows()[0]).toContain('Everyone on this source');
  });

  it('moves the focus to the tab panel when a delete takes the row that held it', async () => {
    let listed1 = true;
    await libraryPage({
      patterns: {
        listPatterns: async () => page(listed1 ? [OWN] : []),
        deletePattern: async () => ((listed1 = false), { ok: true, value: { id: ID, version: 4, deletedAt: '2026-11-12T10:00:00.000Z', purgeAfter: '2026-12-12T10:00:00.000Z' } }),
      },
    });
    await userEvent.click(menuOf('Alpha'));
    await choose('Delete');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete pattern' }));
    await settle();
    expect(screen.getByText('Pattern deleted.')).toBeTruthy();
    expect(tab(/^My patterns · 0/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('tabpanel'));
  });
});

describe('Change and Copy on a definition open the builder of the panel', () => {
  it('opens Explore with the builder on the stored definition for a Change, creating nothing and reading no list again', async () => {
    const kit = await libraryPage({ patterns: { listPatterns: async () => page([OWN]) } });
    await userEvent.click(menuOf('Alpha'));
    await choose('Change');
    await settle();
    await settle();
    expect(kit.router.state.location.pathname).toBe('/explore');
    expect(within(screen.getByRole('complementary', { name: 'Patterns' })).getByLabelText('Starting entity type')).toBeTruthy();
    expect(calls(kit, 'copyPattern')).toHaveLength(0);
  });

  it('opens an unsaved copy of a built-in definition in the builder, and saves nothing', async () => {
    const kit = await libraryPage({ templates: async () => ({ ok: true, value: withDefinition() }) });
    await userEvent.click(tab(/^Built-in/));
    await userEvent.click(menuOf('Fan-out'));
    await choose('Copy');
    await settle();
    await settle();
    expect(within(screen.getByRole('complementary', { name: 'Patterns' })).getByLabelText('Starting entity type')).toBeTruthy();
    expect(calls(kit, 'copyPattern')).toHaveLength(0);
  });
});
