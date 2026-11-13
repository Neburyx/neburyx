import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { savedPatternSchema, type ListedPattern, type PatternListResponse, type SavedPattern } from '@neburyx/contracts';
import type { ApiResult } from '../../api/client.js';
import { failure, listed, settle } from '../patterns-kit.js';
import { openTab, savedWorkspace } from './saved-list.test.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const ID = '0192f000-0000-7000-8000-000000000001';
const page = (items: readonly ListedPattern[]): ApiResult<PatternListResponse> => ({ ok: true, value: { items: [...items], nextCursor: null } });
const stored = (overrides: Partial<SavedPattern> = {}): SavedPattern => savedPatternSchema.parse({ id: ID, sourceId: 'a', name: 'Alpha', askForStartingEntity: false, anchor: null, visibility: 'private', lastRunAt: null, createdAt: '2026-11-12T10:00:00.000Z', updatedAt: '2026-11-12T10:00:00.000Z', version: 2, kind: 'definition', definition: {}, ...overrides });
const menuOf = (name: string): HTMLElement => screen.getByRole('button', { name: `More: ${name}` });
const items = (): string[] => within(screen.getByRole('menu')).getAllByRole('menuitem').map((entry) => entry.textContent ?? '');
const choose = async (name: string): Promise<void> => {
  await userEvent.click(screen.getByRole('menuitem', { name }));
  await settle();
};
const calls = (kit: Awaited<ReturnType<typeof savedWorkspace>>, method: string) => kit.patternCalls.filter((call) => call.method === method);

describe('the menu of a row', () => {
  it('offers Rename, Share, Copy and Delete on a pattern of the person’s own, and Run and Copy on another person’s shared one; a built-in row has no menu', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha' }), listed({ id: '0192f000-0000-7000-8000-000000000002', name: 'Beta', ownedByYou: false, visibility: 'shared', owner: { name: 'Pat' } })]) } });
    await openTab(/My patterns/);
    await userEvent.click(menuOf('Alpha'));
    expect(items()).toEqual(['Run', 'Change', 'Rename', 'Share', 'Copy', 'Delete']);
    await userEvent.keyboard('{Escape}');
    await openTab(/Shared on this source/);
    await userEvent.click(menuOf('Beta'));
    expect(items()).toEqual(['Run', 'Copy', 'Changeowner only', 'Renameowner only', 'Deleteowner only']);
  });

  it('opens with Enter, moves with the arrow keys, and closes with Escape, giving the focus back to its button without closing the panel', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha' })]) } });
    await openTab(/My patterns/);
    menuOf('Alpha').focus();
    await userEvent.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0]);
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[1]);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(menuOf('Alpha'));
    expect(screen.getByRole('complementary', { name: 'Patterns' })).toBeTruthy();
  });
});

describe('renaming, copying and deleting', () => {
  it('renames with the version the list holds, sends nothing for a name outside the limit, and reads the list again', async () => {
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha', version: 3 })]), changePattern: async () => ({ ok: true, value: stored({ name: 'Omega', version: 4 }) }) } });
    await openTab(/My patterns/);
    await userEvent.click(menuOf('Alpha'));
    await choose('Rename');
    const field = screen.getByLabelText('Name');
    expect(screen.getByText('1 to 100 characters. Names are unique among your patterns on this source.')).toBeTruthy();
    await userEvent.clear(field);
    expect(screen.getByRole('alert').textContent).toBe('Enter a name of 1 to 100 characters.');
    expect((screen.getByRole('button', { name: 'Rename' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(field, 'x'.repeat(101));
    expect((screen.getByRole('button', { name: 'Rename' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(field);
    await userEvent.type(field, '  Omega ');
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await settle();
    expect(calls(kit, 'changePattern')).toHaveLength(1);
    expect(calls(kit, 'changePattern')[0]?.args.slice(0, 2)).toEqual([ID, { expectedVersion: 3, name: 'Omega' }]);
    expect(calls(kit, 'listPatterns')).toHaveLength(2);
    expect(screen.getByText('Pattern renamed.')).toBeTruthy();
  });

  it('copies into My patterns and says the server’s refusals in words', async () => {
    let answer: ApiResult<SavedPattern> = { ok: true, value: stored({ id: '0192f000-0000-7000-8000-0000000000c1', name: 'Alpha (copy)', version: 1 }) };
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha' })]), copyPattern: async () => answer } });
    await openTab(/My patterns/);
    await userEvent.click(menuOf('Alpha'));
    await choose('Copy');
    expect(calls(kit, 'copyPattern')[0]?.args[0]).toBe(ID);
    expect(screen.getByText('Pattern copied.')).toBeTruthy();
    for (const [reason, text] of [
      ['pattern-limit', /already holds 200 saved patterns/],
      ['pattern-personal-condition', /personal data/],
    ] as const) {
      answer = { ok: false, failure: failure('INVALID_REQUEST', { reason }) };
      await userEvent.click(menuOf('Alpha'));
      await choose('Copy');
      expect(screen.getByRole('alert').textContent).toMatch(text);
    }
    answer = { ok: false, failure: failure('NOT_FOUND') };
    await userEvent.click(menuOf('Alpha'));
    await choose('Copy');
    expect(screen.getByRole('alert').textContent).toContain('not there any more');
  });

  it('keeps the rename dialog open with the name when the name is already used, says so, holds Rename until the name changes, and does not read the list again', async () => {
    let answer: ApiResult<SavedPattern> = { ok: false, failure: failure('CONFLICT', { reason: 'pattern-name-taken' }) };
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha', version: 3 })]), changePattern: async () => answer } });
    await userEvent.click(menuOf('Alpha'));
    await choose('Rename');
    const field = screen.getByLabelText('Name') as HTMLInputElement;
    await userEvent.clear(field);
    await userEvent.type(field, 'Beta');
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await settle();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(field.value).toBe('Beta');
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe('This name is already used on this source. Choose another.');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect((screen.getByRole('button', { name: 'Rename' }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls(kit, 'listPatterns')).toHaveLength(1);
    answer = { ok: true, value: stored({ name: 'Beta2', version: 4 }) };
    await userEvent.type(field, '2');
    expect((screen.getByRole('button', { name: 'Rename' }) as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls(kit, 'changePattern')).toHaveLength(2);
    expect(calls(kit, 'listPatterns')).toHaveLength(2);
  });

  it('keeps the words of "changed elsewhere", and reads the list again, for a CONFLICT with no reason', async () => {
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha' })]), changePattern: async () => ({ ok: false, failure: failure('CONFLICT') }) } });
    await userEvent.click(menuOf('Alpha'));
    await choose('Rename');
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).not.toMatch(/already used/);
    expect(calls(kit, 'listPatterns')).toHaveLength(2);
  });

  it('deletes after a confirmation, with the version and nothing else; a shared pattern’s confirmation says everyone loses it', async () => {
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha', version: 5 }), listed({ id: '0192f000-0000-7000-8000-000000000002', name: 'Gamma', visibility: 'shared' })]), deletePattern: async () => ({ ok: true, value: { id: ID, version: 6, deletedAt: '2026-11-12T10:00:00.000Z', purgeAfter: '2026-12-12T10:00:00.000Z' } }) } });
    await openTab(/My patterns/);
    await userEvent.click(menuOf('Gamma'));
    await choose('Delete');
    expect(screen.getByRole('heading', { name: 'Delete “Gamma”?' })).toBeTruthy();
    expect(screen.getByText('This pattern is shared with everyone on this source. Deleting it removes it for all of them, and it cannot be recovered. Patterns they copied are not affected.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete for everyone' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(menuOf('Gamma'));
    expect(calls(kit, 'deletePattern')).toHaveLength(0);
    await userEvent.click(menuOf('Alpha'));
    await choose('Delete');
    expect(screen.getByRole('heading', { name: 'Delete “Alpha”?' })).toBeTruthy();
    expect(screen.getByText('This pattern is private to you. It is removed from My patterns and cannot be recovered.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete pattern' }));
    await settle();
    expect(calls(kit, 'deletePattern')[0]?.args.slice(0, 2)).toEqual([ID, 5]);
    expect(screen.getByText('Pattern deleted.')).toBeTruthy();
  });

  it('says the pattern changed on a stale version, reads the list again and overwrites nothing; says it is gone on NOT_FOUND', async () => {
    let refusal = 'CONFLICT';
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha' })]), changePattern: async () => ({ ok: false, failure: failure(refusal) }) } });
    await openTab(/My patterns/);
    await userEvent.click(menuOf('Alpha'));
    await choose('Rename');
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await settle();
    expect(screen.getByText('The pattern changed since you read the list, so the list was read again. Nothing was overwritten.')).toBeTruthy();
    expect(calls(kit, 'listPatterns')).toHaveLength(2);
    refusal = 'NOT_FOUND';
    await userEvent.click(menuOf('Alpha'));
    await choose('Rename');
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await settle();
    expect(screen.getByText('The pattern is not there any more, so the list was read again.')).toBeTruthy();
    expect(calls(kit, 'listPatterns')).toHaveLength(3);
  });

  it('hides the controls of a row after ACCESS_DENIED, when the list read again says it is not the person’s', async () => {
    let reads = 0;
    await savedWorkspace({
      patterns: {
        listPatterns: async () => page([++reads === 1 ? listed({ id: ID, name: 'Alpha' }) : listed({ id: ID, name: 'Alpha', ownedByYou: false, visibility: 'shared', owner: { name: 'Pat' } })]),
        deletePattern: async () => ({ ok: false, failure: failure('ACCESS_DENIED') }),
      },
    });
    await openTab(/My patterns/);
    await userEvent.click(menuOf('Alpha'));
    await choose('Delete');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete pattern' }));
    await settle();
    await openTab(/Shared on this source/);
    await userEvent.click(menuOf('Alpha'));
    expect(items()).toEqual(['Run', 'Copy', 'Changeowner only', 'Renameowner only', 'Deleteowner only']);
  });
});

describe('sharing and unsharing', () => {
  it('shares after a confirmation, sending the visibility and the version alone, and unshares at once', async () => {
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha', version: 2 }), listed({ id: '0192f000-0000-7000-8000-000000000002', name: 'Gamma', visibility: 'shared', version: 7 })]), changePattern: async () => ({ ok: true, value: stored() }) } });
    await openTab(/My patterns/);
    await userEvent.click(menuOf('Alpha'));
    await choose('Share');
    expect(screen.getByText('Everyone on this source will be able to run and copy this pattern. They cannot change or delete it.')).toBeTruthy();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Share' }));
    await settle();
    expect(calls(kit, 'changePattern')[0]?.args.slice(0, 2)).toEqual([ID, { expectedVersion: 2, visibility: 'shared' }]);
    await userEvent.click(menuOf('Gamma'));
    expect(items()).toEqual(['Run', 'Change', 'Rename', 'Unshare', 'Copy', 'Delete']);
    await choose('Unshare');
    expect(calls(kit, 'changePattern')[1]?.args.slice(0, 2)).toEqual(['0192f000-0000-7000-8000-000000000002', { expectedVersion: 7, visibility: 'private' }]);
  });

  it('says a share refused for personal data in words and leaves the pattern private; a stale version reads the list again', async () => {
    let refusal = failure('INVALID_REQUEST', { reason: 'pattern-personal-condition' });
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha' })]), changePattern: async () => ({ ok: false, failure: refusal }) } });
    await openTab(/My patterns/);
    await userEvent.click(menuOf('Alpha'));
    await choose('Share');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Share' }));
    await settle();
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toMatch(/personal data/);
    expect(screen.getByText(/Not run yet/)).toBeTruthy();
    refusal = failure('CONFLICT');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Share' }));
    await settle();
    expect(calls(kit, 'listPatterns')).toHaveLength(2);
  });
});

describe('focus and repeated presses', () => {
  it('gives the focus back to the menu button after Copy and after a dialog closes', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha' })]), copyPattern: async () => ({ ok: true, value: stored() }) } });
    await openTab(/My patterns/);
    await userEvent.click(menuOf('Alpha'));
    await choose('Copy');
    expect(document.activeElement).toBe(menuOf('Alpha'));
    await userEvent.click(menuOf('Alpha'));
    await choose('Rename');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(menuOf('Alpha'));
  });

  it('sends one request when Copy is chosen twice while the first is on its way', async () => {
    let release: (answer: ApiResult<SavedPattern>) => void = () => undefined;
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha' })]), copyPattern: () => new Promise((resolve) => (release = resolve)) } });
    await openTab(/My patterns/);
    await userEvent.click(menuOf('Alpha'));
    await choose('Copy');
    await userEvent.click(menuOf('Alpha'));
    await choose('Copy');
    expect(calls(kit, 'copyPattern')).toHaveLength(1);
    release({ ok: true, value: stored() });
    await settle();
  });
});
