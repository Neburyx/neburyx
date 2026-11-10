import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { DeleteInvestigationResponse } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { draftSyncOf } from '../draft/draft-sync.js';
import { elementKey } from '../state/keys.js';
import { ref } from '../state/test-data.js';
import { ID, flush, investigationOf, renderLifecycle, shownState, failure } from './harness.js';

const answer = (version: number): ApiResult<DeleteInvestigationResponse> => ({ ok: true, value: { id: ID, version, deletedAt: '2026-11-10T10:00:00.000Z', purgeAfter: '2026-12-10T10:00:00.000Z' } });

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}|${JSON.stringify(location.state)}`}</p>;
}

const button = () => screen.getByRole('button', { name: 'Investigation menu' });
const dialog = () => screen.getByRole('dialog', { name: 'Delete this investigation?' });

async function openDialog(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(button());
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
}

describe('Delete in the investigation menu', () => {
  it('asks first: the confirm says it can be restored, puts the focus on Cancel, and Escape and Cancel send nothing and return the focus to the menu', async () => {
    const deleteInvestigation = vi.fn();
    renderLifecycle(shownState('open'), { deleteInvestigation }, <Where />);
    const user = userEvent.setup();
    await openDialog(user);
    expect(within(dialog()).getByText(/can be restored from the Deleted list until its purge date/)).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(within(dialog()).getByRole('button', { name: 'Delete investigation' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button());
    await openDialog(user);
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button());
    expect(deleteInvestigation).not.toHaveBeenCalled();
    expect(screen.getByTestId('where').textContent).toBe('/|null');
  });

  it.each(['open', 'closed', 'archived'] as const)('is offered for an investigation that is %s', async (status) => {
    renderLifecycle(shownState(status));
    await userEvent.setup().click(button());
    expect(screen.getByRole('menuitem', { name: 'Delete' }).getAttribute('aria-disabled')).toBeNull();
  });

  it('sends the delete with the version the record holds, forgets the investigation and goes to the Investigations page with the date it can be restored until', async () => {
    const deleteInvestigation = vi.fn(async () => answer(4));
    const rendered = renderLifecycle(shownState('open', 3), { deleteInvestigation }, <Where />);
    const forget = vi.spyOn(rendered.state, 'forget');
    const user = userEvent.setup();
    await openDialog(user);
    await user.click(within(dialog()).getByRole('button', { name: 'Delete investigation' }));
    await flush();
    expect(deleteInvestigation).toHaveBeenCalledWith(ID, 3);
    expect(forget).toHaveBeenCalledWith(ID);
    expect(screen.getByTestId('where').textContent).toBe(`/investigations|${JSON.stringify({ notice: 'Investigation deleted. Restorable until 10 Dec 2026 10:00 UTC.' })}`);
  });

  it('sends one request when Delete investigation is pressed twice at once', async () => {
    let finish: (value: ApiResult<DeleteInvestigationResponse>) => void = () => undefined;
    const deleteInvestigation = vi.fn(() => new Promise<ApiResult<DeleteInvestigationResponse>>((resolve) => (finish = resolve)));
    renderLifecycle(shownState('open', 3), { deleteInvestigation });
    const user = userEvent.setup();
    await openDialog(user);
    const confirm = within(dialog()).getByRole('button', { name: 'Delete investigation' });
    await user.click(confirm);
    await user.click(within(dialog()).getByRole('button', { name: 'Deleting…' }));
    expect(deleteInvestigation).toHaveBeenCalledTimes(1);
    finish(answer(4));
    await flush();
  });

  it('keeps the dialog on a version that changed elsewhere, shows the server\'s message with Reload, and Reload reads the investigation again', async () => {
    const deleteInvestigation = vi.fn(async (): Promise<ApiResult<DeleteInvestigationResponse>> => ({ ok: false, failure: failure('CONFLICT', 'This item was changed elsewhere. Reload to continue.') }));
    const getInvestigation = vi.fn(async () => ({ ok: true as const, value: { investigation: investigationOf('open', 5, 'Renamed elsewhere') } as never }));
    const state = shownState('open', 3);
    renderLifecycle(state, { deleteInvestigation, getInvestigation }, <Where />);
    const user = userEvent.setup();
    await openDialog(user);
    await user.click(within(dialog()).getByRole('button', { name: 'Delete investigation' }));
    await flush();
    expect(within(dialog()).getByRole('alert').textContent).toContain('This item was changed elsewhere. Reload to continue.');
    expect(screen.getByTestId('where').textContent).toBe('/|null');
    await user.click(within(dialog()).getByRole('button', { name: 'Reload' }));
    await flush();
    expect(getInvestigation).toHaveBeenCalledWith(ID);
    expect(state.investigation.getState().record).toMatchObject({ title: 'Renamed elsewhere', version: 5 });
    expect(within(dialog()).queryByRole('alert')).toBeNull();
  });

  it('goes to the Investigations page when the investigation is already gone', async () => {
    const deleteInvestigation = vi.fn(async (): Promise<ApiResult<DeleteInvestigationResponse>> => ({ ok: false, failure: failure('NOT_FOUND', 'Not found.') }));
    renderLifecycle(shownState('open'), { deleteInvestigation }, <Where />);
    const user = userEvent.setup();
    await openDialog(user);
    await user.click(within(dialog()).getByRole('button', { name: 'Delete investigation' }));
    await flush();
    expect(screen.getByTestId('where').textContent).toBe('/investigations|null');
  });

  it.each([
    ['an internal error', async (): Promise<ApiResult<DeleteInvestigationResponse>> => ({ ok: false, failure: failure('INTERNAL_ERROR', 'Something went wrong.') }), 'Something went wrong.'],
    ['a network failure', async (): Promise<ApiResult<DeleteInvestigationResponse>> => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }), 'The request could not be sent. Try again.'],
  ])('keeps the dialog with the message after %s, and Delete investigation can be pressed again', async (_name, first, message) => {
    const deleteInvestigation = vi.fn(first);
    renderLifecycle(shownState('open', 3), { deleteInvestigation }, <Where />);
    const user = userEvent.setup();
    await openDialog(user);
    await user.click(within(dialog()).getByRole('button', { name: 'Delete investigation' }));
    await flush();
    expect(within(dialog()).getByRole('alert').textContent).toBe(message);
    expect(screen.getByTestId('where').textContent).toBe('/|null');
    deleteInvestigation.mockImplementation(async () => answer(4));
    await user.click(within(dialog()).getByRole('button', { name: 'Delete investigation' }));
    await flush();
    expect(deleteInvestigation).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('where').textContent).toContain('/investigations|');
  });

  it('traps the focus inside the dialog', async () => {
    renderLifecycle(shownState('open'));
    const user = userEvent.setup();
    await openDialog(user);
    await user.tab();
    await user.tab();
    await user.tab();
    expect(dialog().contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(dialog().contains(document.activeElement)).toBe(true);
  });

  it('drops the changes not yet written instead of saving them, since the investigation is going away, and then sends the delete', async () => {
    const saveDraft = vi.fn(async () => ({ ok: false as const, failure: { code: 'NETWORK_UNAVAILABLE' as const } }));
    const deleteInvestigation = vi.fn(async () => answer(4));
    const state = shownState('open', 3);
    const rendered = renderLifecycle(state, { deleteInvestigation, saveDraft }, <Where />);
    draftSyncOf(state, rendered.client).adopt(ID, { version: 1, notes: null, basedOnViewId: null, writable: true });
    state.presentation.setPosition(elementKey(ref('demo', 'type-a', 'A')), { x: 5, y: 5 });
    const user = userEvent.setup();
    await openDialog(user);
    await user.click(within(dialog()).getByRole('button', { name: 'Delete investigation' }));
    await flush();
    expect(saveDraft).not.toHaveBeenCalled();
    expect(deleteInvestigation).toHaveBeenCalledWith(ID, 3);
  });
});
