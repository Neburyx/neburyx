import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { RenameResponse } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { failure, flush, ID, investigationOf, renderLifecycle, shownState } from './harness.js';
import { titleProblemOf } from './rename-dialog.js';

const renamed = (title: string, version: number): ApiResult<RenameResponse> => ({ ok: true, value: { investigation: investigationOf('open', version, title) } });
const button = () => screen.getByRole('button', { name: 'Investigation menu' });
const dialog = () => screen.getByRole('dialog', { name: 'Rename investigation' });

async function opened(overrides: Parameters<typeof renderLifecycle>[1] = {}, state = shownState('open', 3)) {
  const rendered = renderLifecycle(state, overrides);
  const user = userEvent.setup();
  await user.click(button());
  await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
  return { ...rendered, user };
}

describe('the rename dialog', () => {
  it('opens with the name, the focus in the input, the hint described to the input, Cancel and Rename', async () => {
    await opened();
    const input = within(dialog()).getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
    expect(input.value).toBe('Suspicious linked accounts');
    expect(document.activeElement).toBe(input);
    expect(document.getElementById(input.getAttribute('aria-describedby')?.split(' ')[0] ?? '')?.textContent).toBe("Don't type customer names; others may see this text.");
    expect(within(dialog()).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect((within(dialog()).getByRole('button', { name: 'Rename' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends the title with the record version, then closes, shows the new title and the new version, and returns focus to the button', async () => {
    const renameInvestigation = vi.fn(async (_id: string, title: string) => renamed(title, 4));
    const { state, user } = await opened({ renameInvestigation });
    const input = within(dialog()).getByRole('textbox', { name: 'Name' });
    await user.clear(input);
    await user.type(input, 'Mule ring');
    await user.click(within(dialog()).getByRole('button', { name: 'Rename' }));
    await flush();
    expect(renameInvestigation).toHaveBeenCalledWith(ID, 'Mule ring', 3);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Mule ring');
    expect(state.investigation.getState().record).toMatchObject({ title: 'Mule ring', version: 4 });
    expect(document.activeElement).toBe(button());
  });

  it('submits with Enter when the title is valid', async () => {
    const renameInvestigation = vi.fn(async (_id: string, title: string) => renamed(title, 4));
    const { user } = await opened({ renameInvestigation });
    await user.type(within(dialog()).getByRole('textbox', { name: 'Name' }), '!{Enter}');
    await flush();
    expect(renameInvestigation).toHaveBeenCalledWith(ID, 'Suspicious linked accounts!', 3);
  });

  it.each([
    ['empty', '', 'Enter a name.'],
    ['only whitespace', '   ', 'Enter a name.'],
    ['201 characters', 'a'.repeat(201), 'Use 200 characters or fewer.'],
    ['201 code points of emoji', '\u{1F600}'.repeat(201), 'Use 200 characters or fewer.'],
  ])('disables Rename for a title that is %s, says why and sends nothing', async (_name, title, message) => {
    const renameInvestigation = vi.fn(async (_id: string, text: string) => renamed(text, 4));
    const { user } = await opened({ renameInvestigation });
    const input = within(dialog()).getByRole('textbox', { name: 'Name' });
    await user.clear(input);
    if (title.length > 0) await user.click(input), await user.paste(title);
    expect((within(dialog()).getByRole('button', { name: 'Rename' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog()).getByText(message)).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(renameInvestigation).not.toHaveBeenCalled();
  });

  it('accepts a title of 200 code points that include an emoji, and a title with accents', async () => {
    const renameInvestigation = vi.fn(async (_id: string, text: string) => renamed(text, 4));
    const { user } = await opened({ renameInvestigation });
    const input = within(dialog()).getByRole('textbox', { name: 'Name' });
    const title = `é\u{1F600}${'b'.repeat(198)}`;
    await user.clear(input);
    await user.click(input);
    await user.paste(title);
    await user.click(within(dialog()).getByRole('button', { name: 'Rename' }));
    await flush();
    expect(renameInvestigation).toHaveBeenCalledWith(ID, title, 3);
  });

  it('judges a title as the server does', () => {
    expect(titleProblemOf('Mule ring')).toBeUndefined();
    expect(titleProblemOf('a\u0000b')).toBe('Remove the characters that cannot be stored.');
    expect(titleProblemOf('a\ud800b')).toBe('Remove the characters that cannot be stored.');
    expect(titleProblemOf('\u{1F600}'.repeat(200))).toBeUndefined();
  });

  it('keeps the dialog open with the plain conflict message and Reload, which reads the investigation again', async () => {
    const getInvestigation = vi.fn(async () => ({ ok: true as const, value: { investigation: investigationOf('open', 9, 'Renamed elsewhere'), draft: { version: 1, layout: { schemaVersion: 1 as const, layout: 'force', nodes: [], edges: [], groups: [] }, queryContext: { schemaVersion: 1 as const, loaded: { nodes: [], edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } }, notes: null } } }));
    const { state, user } = await opened({ getInvestigation, renameInvestigation: async () => ({ ok: false, failure: failure('CONFLICT', 'This item was changed elsewhere. Reload to continue.') }) });
    await user.type(within(dialog()).getByRole('textbox', { name: 'Name' }), '!');
    await user.click(within(dialog()).getByRole('button', { name: 'Rename' }));
    await flush();
    expect(within(dialog()).getByRole('alert').textContent).toContain('This item was changed elsewhere. Reload to continue.');
    expect(state.investigation.getState().record?.title).toBe('Suspicious linked accounts');
    await user.click(within(dialog()).getByRole('button', { name: 'Reload' }));
    await flush();
    expect(getInvestigation).toHaveBeenCalledWith(ID);
    expect(state.investigation.getState().record).toMatchObject({ title: 'Renamed elsewhere', version: 9 });
    expect(within(dialog()).queryByRole('alert')).toBeNull();
  });

  it('says "Reopen to rename." and reads the investigation again when it was closed meanwhile', async () => {
    const getInvestigation = vi.fn(async () => ({ ok: true as const, value: { investigation: investigationOf('closed', 4), draft: { version: 1, layout: { schemaVersion: 1 as const, layout: 'force', nodes: [], edges: [], groups: [] }, queryContext: { schemaVersion: 1 as const, loaded: { nodes: [], edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } }, notes: null } } }));
    const { state, user } = await opened({ getInvestigation, renameInvestigation: async () => ({ ok: false, failure: failure('CONFLICT', 'This investigation is closed or archived. Reopen it to make changes.', { reason: 'investigation-read-only', status: 'closed' }) }) });
    await user.type(within(dialog()).getByRole('textbox', { name: 'Name' }), '!');
    await user.click(within(dialog()).getByRole('button', { name: 'Rename' }));
    await flush();
    expect(within(dialog()).getByRole('alert').textContent).toBe('Reopen to rename.');
    expect(getInvestigation).toHaveBeenCalledTimes(1);
    expect(state.investigation.getState().record).toMatchObject({ status: 'closed', readOnly: true });
  });

  it.each([
    ['NOT_FOUND', failure('NOT_FOUND', 'Not found.')],
    ['INTERNAL_ERROR', failure('INTERNAL_ERROR', 'Something went wrong. Quote the trace ID if you contact support.')],
  ])('keeps the dialog open with the own message of a %s and the title unchanged', async (_code, refused) => {
    const { state, user } = await opened({ renameInvestigation: async () => ({ ok: false, failure: refused }) });
    await user.type(within(dialog()).getByRole('textbox', { name: 'Name' }), '!');
    await user.click(within(dialog()).getByRole('button', { name: 'Rename' }));
    await flush();
    expect(within(dialog()).getByRole('alert').textContent).toBe('message' in refused ? refused.message : '');
    expect(state.investigation.getState().record?.title).toBe('Suspicious linked accounts');
    expect(within(dialog()).queryByRole('button', { name: 'Reload' })).toBeNull();
  });

  it('keeps the dialog open with a sentence for a network failure', async () => {
    const { user } = await opened({ renameInvestigation: async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    await user.type(within(dialog()).getByRole('textbox', { name: 'Name' }), '!');
    await user.click(within(dialog()).getByRole('button', { name: 'Rename' }));
    await flush();
    expect(within(dialog()).getByRole('alert').textContent).toBe('The request could not be sent. Try again.');
  });

  it('sends nothing on Esc or Cancel, and returns focus to the button', async () => {
    const renameInvestigation = vi.fn(async (_id: string, text: string) => renamed(text, 4));
    const { user } = await opened({ renameInvestigation });
    await user.type(within(dialog()).getByRole('textbox', { name: 'Name' }), '!');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button());
    await user.click(button());
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button());
    expect(renameInvestigation).not.toHaveBeenCalled();
  });

  it('keeps Tab inside the dialog', async () => {
    const { user } = await opened();
    const input = within(dialog()).getByRole('textbox', { name: 'Name' });
    await user.type(input, '!');
    for (let presses = 0; presses < 6; presses += 1) {
      await user.tab();
      expect(dialog().contains(document.activeElement)).toBe(true);
    }
  });
});
