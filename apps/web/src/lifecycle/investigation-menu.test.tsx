import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { answerOf, failure, flush, ID, investigationOf, renderLifecycle, shownState } from './harness.js';

const button = () => screen.getByRole('button', { name: 'Investigation menu' });
const items = () => within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent);

describe('the investigation menu', () => {
  it('lists Rename, Close and Archive of an open investigation, and no Delete', async () => {
    renderLifecycle(shownState('open'));
    await userEvent.setup().click(button());
    expect(items()).toEqual(['Rename', 'Close', 'Archive']);
    expect(screen.queryByRole('menuitem', { name: /delete/i })).toBeNull();
  });

  it('lists Reopen, Archive and a disabled Rename described as "Reopen to rename." for a closed one', async () => {
    renderLifecycle(shownState('closed'));
    await userEvent.setup().click(button());
    expect(items()).toEqual(['RenameReopen to rename.', 'Reopen', 'Archive']);
    const rename = screen.getByRole('menuitem', { name: /Rename/ });
    expect(rename.getAttribute('aria-disabled')).toBe('true');
    expect(rename.getAttribute('aria-describedby')).not.toBeNull();
    expect(document.getElementById(rename.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Reopen to rename.');
  });

  it('lists Reopen and a disabled Rename for an archived one', async () => {
    renderLifecycle(shownState('archived'));
    await userEvent.setup().click(button());
    expect(items()).toEqual(['RenameReopen to rename.', 'Reopen']);
  });

  it('does not open the rename dialog from a disabled Rename', async () => {
    renderLifecycle(shownState('closed'));
    const user = userEvent.setup();
    await user.click(button());
    await user.click(screen.getByRole('menuitem', { name: /Rename/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([
    ['Close', 'closed'],
    ['Archive', 'archived'],
  ] as const)('sends %s with the record version, takes the answer, shows the banner and returns focus to the button', async (label, status) => {
    const changeInvestigationStatus = vi.fn(async () => answerOf(status, 4));
    const state = shownState('open', 3);
    renderLifecycle(state, { changeInvestigationStatus });
    const user = userEvent.setup();
    await user.click(button());
    await user.click(screen.getByRole('menuitem', { name: label }));
    await flush();
    expect(changeInvestigationStatus).toHaveBeenCalledWith(ID, status, 3);
    expect(state.investigation.getState().record).toMatchObject({ status, readOnly: true, version: 4 });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('region', { name: 'Request status' })).toBeTruthy();
    expect(screen.getAllByRole('status').some((element) => element.textContent === (status === 'closed' ? 'Closed · read-only' : 'Archived · read-only'))).toBe(true);
    expect(document.activeElement).toBe(button());
  });

  it('reopens, and then lists Rename, Close and Archive; Close then Reopen then Close succeed with no reload between', async () => {
    let version = 3;
    const changeInvestigationStatus = vi.fn(async (_id: string, status: 'open' | 'closed' | 'archived') => answerOf(status, ++version));
    const state = shownState('open', 3);
    renderLifecycle(state, { changeInvestigationStatus });
    const user = userEvent.setup();
    await user.click(button());
    await user.click(screen.getByRole('menuitem', { name: 'Close' }));
    await flush();
    await user.click(button());
    await user.click(screen.getByRole('menuitem', { name: 'Reopen' }));
    await flush();
    expect(state.investigation.getState().record).toMatchObject({ status: 'open', readOnly: false, version: 5 });
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
    await user.click(button());
    expect(items()).toEqual(['Rename', 'Close', 'Archive']);
    await user.click(screen.getByRole('menuitem', { name: 'Close' }));
    await flush();
    expect(changeInvestigationStatus.mock.calls.map((call) => [call[1]])).toEqual([['closed'], ['open'], ['closed']]);
    expect(state.investigation.getState().record).toMatchObject({ status: 'closed', version: 6 });
  });

  it.each([
    ['CONFLICT', failure('CONFLICT', 'This item was changed elsewhere. Reload to continue.')],
    ['NOT_FOUND', failure('NOT_FOUND', 'Not found.')],
    ['INTERNAL_ERROR', failure('INTERNAL_ERROR', 'Something went wrong. Quote the trace ID if you contact support.')],
  ])('closes the menu and shows the own message of a %s as a request banner, leaving the record', async (code, refused) => {
    const state = shownState('open', 3);
    renderLifecycle(state, { changeInvestigationStatus: async () => ({ ok: false, failure: refused }) });
    const user = userEvent.setup();
    await user.click(button());
    await user.click(screen.getByRole('menuitem', { name: 'Close' }));
    await flush();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByText('message' in refused ? refused.message : '')).toBeTruthy();
    expect(state.investigation.getState().record).toMatchObject({ status: 'open', version: 3 });
    expect(screen.queryByRole('button', { name: 'Reload' }) !== null).toBe(code !== 'NOT_FOUND');
  });

  it('reads the investigation again on Reload after a CONFLICT and takes its status', async () => {
    const getInvestigation = vi.fn(async () => ({ ok: true as const, value: { investigation: investigationOf('closed', 9), draft: { version: 1, layout: { schemaVersion: 1 as const, layout: 'force', nodes: [], edges: [], groups: [] }, queryContext: { schemaVersion: 1 as const, loaded: { nodes: [], edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } }, notes: null } } }));
    const state = shownState('open', 3);
    renderLifecycle(state, { getInvestigation, changeInvestigationStatus: async () => ({ ok: false, failure: failure('CONFLICT', 'This item was changed elsewhere. Reload to continue.') }) });
    const user = userEvent.setup();
    await user.click(button());
    await user.click(screen.getByRole('menuitem', { name: 'Close' }));
    await flush();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await flush();
    expect(getInvestigation).toHaveBeenCalledWith(ID);
    expect(state.investigation.getState().record).toMatchObject({ status: 'closed', readOnly: true, version: 9 });
  });

  it('treats an internal error as an unknown outcome: Reload takes the stored status', async () => {
    const getInvestigation = vi.fn(async () => ({ ok: true as const, value: { investigation: investigationOf('closed', 4), draft: { version: 1, layout: { schemaVersion: 1 as const, layout: 'force', nodes: [], edges: [], groups: [] }, queryContext: { schemaVersion: 1 as const, loaded: { nodes: [], edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } }, notes: null } } }));
    const state = shownState('open', 3);
    renderLifecycle(state, { getInvestigation, changeInvestigationStatus: async () => ({ ok: false, failure: failure('INTERNAL_ERROR', 'Something went wrong. Quote the trace ID if you contact support.') }) });
    const user = userEvent.setup();
    await user.click(button());
    await user.click(screen.getByRole('menuitem', { name: 'Close' }));
    await flush();
    expect(screen.getByText('The change may not have been made. Reload to see.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await flush();
    expect(state.investigation.getState().record).toMatchObject({ status: 'closed', version: 4 });
  });

  it('says the change may not have been made when the answer was lost, and offers Reload', async () => {
    renderLifecycle(shownState('open'), { changeInvestigationStatus: async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    const user = userEvent.setup();
    await user.click(button());
    await user.click(screen.getByRole('menuitem', { name: 'Close' }));
    await flush();
    expect(screen.getByText('The change may not have been made. Reload to see.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('announces a change from closed to archived', async () => {
    const state = shownState('closed', 3);
    renderLifecycle(state, { changeInvestigationStatus: async () => answerOf('archived', 4) });
    const user = userEvent.setup();
    await user.click(button());
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));
    await flush();
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain('Archived. This investigation is archived and read-only.');
  });

  it('shows a network failure as a request banner', async () => {
    renderLifecycle(shownState('open'), { changeInvestigationStatus: async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    const user = userEvent.setup();
    await user.click(button());
    await user.click(screen.getByRole('menuitem', { name: 'Close' }));
    await flush();
    expect(screen.getByText('The request could not be sent. Try again.')).toBeTruthy();
  });

  it('disables the status items while a call is under way, and a second choice sends nothing', async () => {
    let release: (value: ReturnType<typeof answerOf>) => void = () => undefined;
    const changeInvestigationStatus = vi.fn(() => new Promise<ReturnType<typeof answerOf>>((resolve) => (release = resolve)));
    renderLifecycle(shownState('open', 3), { changeInvestigationStatus });
    const user = userEvent.setup();
    await user.click(button());
    await user.click(screen.getByRole('menuitem', { name: 'Close' }));
    await user.click(button());
    expect(screen.getByRole('menuitem', { name: 'Close' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('menuitem', { name: 'Archive' }).getAttribute('aria-disabled')).toBe('true');
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));
    await user.click(screen.getByRole('menuitem', { name: 'Close' }));
    expect(changeInvestigationStatus).toHaveBeenCalledTimes(1);
    release(answerOf('closed', 4));
    await flush();
  });
});

describe('the investigation menu with the keyboard', () => {
  it('opens with Enter, moves with the arrows, chooses with Enter and returns focus to the button', async () => {
    const changeInvestigationStatus = vi.fn(async () => answerOf('closed', 4));
    renderLifecycle(shownState('open', 3), { changeInvestigationStatus });
    const user = userEvent.setup();
    button().focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Close' }));
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }));
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Archive' }));
    await user.keyboard('{ArrowUp}{Enter}');
    await flush();
    expect(changeInvestigationStatus).toHaveBeenCalledWith(ID, 'closed', 3);
    expect(document.activeElement).toBe(button());
  });

  it('closes the menu when Tab moves the focus on', async () => {
    renderLifecycle(shownState('open'));
    const user = userEvent.setup();
    await user.click(button());
    await user.keyboard('{Tab}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens with Space', async () => {
    renderLifecycle(shownState('open'));
    const user = userEvent.setup();
    button().focus();
    await user.keyboard(' ');
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('closes with Esc and returns focus to the button', async () => {
    renderLifecycle(shownState('open'));
    const user = userEvent.setup();
    await user.click(button());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button());
  });
});
