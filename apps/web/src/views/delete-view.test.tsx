import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { clientWith, me, renderApp, source } from '../test-utils.js';
import { registerBuiltInSlots } from '../workspace/built-in-slots.js';
import { createSlotRegistry } from '../workspace/slots.js';
import { failure, INVESTIGATION_ID, namedView, rig, viewsServer } from './view-fixtures.js';

afterEach(cleanup);

function shown(server: ReturnType<typeof viewsServer>, overrides: Parameters<typeof rig>[0] = {}) {
  const base = clientWith({ me: me(), sources: [source('demo', { alias: 'fincrime' })] });
  const parts = rig({ base, listViews: server.listViews, renameView: server.renameView, overrides: { deleteView: server.deleteView }, ...overrides });
  const slots = createSlotRegistry();
  registerBuiltInSlots(slots);
  renderApp(`/explore/${INVESTIGATION_ID}`, parts.client, parts.state, slots);
  return parts;
}

const three = () => viewsServer([namedView(3, { name: 'Shared device ring' }), namedView(2, { name: 'Before expanding the IP address' }), namedView(1, { name: 'First pass' })]);
const panel = () => screen.getByRole('dialog', { name: /^Views/ });
const dialog = (name = /^Delete “/) => screen.getByRole('dialog', { name });

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /^Views/ }));
  await screen.findByRole('heading', { name: /^Views · / });
  return panel();
}

async function openDelete(user: ReturnType<typeof userEvent.setup>, name: string) {
  const view = within(await open(user));
  await user.click(view.getByRole('button', { name: `Delete ${name}` }));
}

describe('Delete in the Views panel', () => {
  it('asks first: the confirm names the view, says it cannot be restored and the draft is unchanged, has a note field with the hint, and puts the focus on the note', async () => {
    const user = userEvent.setup();
    shown(three());
    await openDelete(user, 'Shared device ring');
    const confirm = within(dialog(/^Delete “Shared device ring”\?$/));
    expect(confirm.getByText("The view is deleted and can't be restored. Your draft is not changed.")).toBeTruthy();
    const note = confirm.getByRole('textbox', { name: 'Note (optional)' });
    expect(document.activeElement).toBe(note);
    expect(note.getAttribute('aria-describedby')).toContain(confirm.getByText("Don't type customer names; others may see this text.").id);
    expect(confirm.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(confirm.getByRole('button', { name: 'Delete view' })).toBeTruthy();
  });

  it('closes on Escape and on Cancel without sending, discards the note, and returns the focus to that row\'s Delete', async () => {
    const user = userEvent.setup();
    const server = three();
    shown(server);
    await openDelete(user, 'First pass');
    await user.type(within(dialog()).getByRole('textbox'), 'half a thought');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: /^Delete/ })).toBeNull();
    expect(document.activeElement).toBe(within(panel()).getByRole('button', { name: 'Delete First pass' }));
    await user.click(within(panel()).getByRole('button', { name: 'Delete First pass' }));
    expect((within(dialog()).getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(server.deleted).toEqual([]);
    expect(document.activeElement).toBe(within(panel()).getByRole('button', { name: 'Delete First pass' }));
  });

  it('sends the version and the note, removes the row, updates the count, says it in a live region, and moves the focus to the next row\'s Restore into draft', async () => {
    const user = userEvent.setup();
    const server = three();
    const parts = shown(server);
    await openDelete(user, 'Before expanding the IP address');
    await user.type(within(dialog()).getByRole('textbox'), 'Duplicate of the review view');
    await user.click(within(dialog()).getByRole('button', { name: 'Delete view' }));
    await waitFor(() => expect(within(panel()).queryByText('Before expanding the IP address')).toBeNull());
    expect(server.deleted).toEqual([{ viewId: expect.any(String), version: 1, note: 'Duplicate of the review view' }]);
    const view = within(panel());
    expect(view.getByRole('heading', { name: 'Views · 2' })).toBeTruthy();
    expect(view.getByText('View deleted.').getAttribute('role')).toBe('status');
    await waitFor(() => expect(document.activeElement).toBe(view.getByRole('button', { name: 'Restore First pass into draft' })));
    expect(parts.state.investigation.getState().record?.save).toEqual({ kind: 'unsaved' });
  });

  it('sends no note when none was typed, and moves the focus to the previous row when the last row is deleted, and to the empty note when none is left', async () => {
    const user = userEvent.setup();
    const server = viewsServer([namedView(2, { name: 'Second' }), namedView(1, { name: 'First' })]);
    shown(server);
    await openDelete(user, 'First');
    await user.click(within(dialog()).getByRole('button', { name: 'Delete view' }));
    await waitFor(() => expect(document.activeElement).toBe(within(panel()).getByRole('button', { name: 'Restore Second into draft' })));
    expect(server.deleted[0]?.note).toBeNull();
    await user.click(within(panel()).getByRole('button', { name: 'Delete Second' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Delete view' }));
    await waitFor(() => expect(document.activeElement).toBe(within(panel()).getByText('No named views yet.')));
  });

  it('refuses a note over 10,000 characters with a described error and a disabled Delete view', async () => {
    const user = userEvent.setup();
    shown(three());
    await openDelete(user, 'Shared device ring');
    const note = within(dialog()).getByRole('textbox') as HTMLTextAreaElement;
    note.focus();
    await user.paste('a'.repeat(10_001));
    const problem = within(dialog()).getByText('A note is at most 10,000 characters.');
    expect(note.getAttribute('aria-invalid')).toBe('true');
    expect(note.getAttribute('aria-describedby')).toContain(problem.id);
    expect((within(dialog()).getByRole('button', { name: 'Delete view' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows no Delete on a row that is being renamed', async () => {
    const user = userEvent.setup();
    shown(three());
    const view = within(await open(user));
    await user.click(view.getByRole('button', { name: 'Rename First pass' }));
    expect(view.queryByRole('button', { name: 'Delete First pass' })).toBeNull();
    expect(view.getByRole('button', { name: 'Delete Shared device ring' })).toBeTruthy();
  });

  it('closes the dialog on a stale version, says the view was renamed elsewhere, and reads the list again', async () => {
    const user = userEvent.setup();
    const server = three();
    shown(server, { overrides: { deleteView: async () => failure('CONFLICTED_VIEW_VERSION') } });
    await openDelete(user, 'Shared device ring');
    const reads = server.listed.length;
    await user.click(within(dialog()).getByRole('button', { name: 'Delete view' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Delete/ })).toBeNull());
    expect(within(panel()).getByText('This view was renamed elsewhere. The list is updated.')).toBeTruthy();
    expect(server.listed.length).toBeGreaterThan(reads);
  });

  it('says the view was already deleted and removes the row when the server answers NOT_FOUND', async () => {
    const user = userEvent.setup();
    const server = three();
    shown(server, { overrides: { deleteView: async () => failure('NOT_FOUND') } });
    await openDelete(user, 'Shared device ring');
    await user.click(within(dialog()).getByRole('button', { name: 'Delete view' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Delete/ })).toBeNull());
    expect(within(panel()).getByText('This view was already deleted. The list is updated.')).toBeTruthy();
  });

  it('keeps the dialog, the typed note and the row after an internal error, shows the error\'s message, and sends again', async () => {
    const user = userEvent.setup();
    const server = three();
    let fail = true;
    const parts = shown(server, {
      overrides: {
        deleteView: async (id, viewId, version, note) => (fail ? { ok: false as const, failure: { code: 'INTERNAL_ERROR' as const, message: 'Something went wrong.', retryable: true, traceId: 't' } } : server.deleteView(id, viewId, version, note)),
      },
    });
    await openDelete(user, 'Shared device ring');
    await user.type(within(dialog()).getByRole('textbox'), 'keep me');
    await user.click(within(dialog()).getByRole('button', { name: 'Delete view' }));
    expect((await within(dialog()).findByRole('alert')).textContent).toBe('Something went wrong.');
    expect((within(dialog()).getByRole('textbox') as HTMLTextAreaElement).value).toBe('keep me');
    expect(within(panel()).getByText('Shared device ring')).toBeTruthy();
    fail = false;
    await user.click(within(dialog()).getByRole('button', { name: 'Delete view' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Delete/ })).toBeNull());
    expect(server.deleted.at(-1)?.note).toBe('keep me');
    expect(parts.state.investigation.getState().record).not.toBeNull();
  });

  it('sends one request when Delete view is pressed twice at once', async () => {
    const user = userEvent.setup();
    const server = three();
    let sent = 0;
    shown(server, {
      overrides: {
        deleteView: () => {
          sent += 1;
          return new Promise(() => undefined);
        },
      },
    });
    await openDelete(user, 'Shared device ring');
    await user.click(within(dialog()).getByRole('button', { name: 'Delete view' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Deleting…' }));
    expect(sent).toBe(1);
  });

  it.each(['closed', 'archived'] as const)('is disabled, described by the reason line, when the investigation is %s', async (status) => {
    const user = userEvent.setup();
    const parts = shown(three());
    const held = parts.state.investigation.getState().record;
    if (held === null) throw new Error('the fixture shows an investigation');
    parts.state.describeInvestigation({ ...held, status, readOnly: true });
    const view = within(await open(user));
    const button = view.getByRole('button', { name: 'Delete Shared device ring' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Reopen to restore, rename or delete views.');
  });

  it('shows the error\'s own message and updates the header when the server refuses it as read-only', async () => {
    const user = userEvent.setup();
    const message = 'This investigation is closed or archived. Reopen it to make changes.';
    const parts = shown(three(), { overrides: { deleteView: async () => ({ ok: false as const, failure: { code: 'CONFLICT' as const, message, retryable: false, traceId: 't', details: { reason: 'investigation-read-only' as const, status: 'closed' as const } } }) } });
    await openDelete(user, 'Shared device ring');
    await user.click(within(dialog()).getByRole('button', { name: 'Delete view' }));
    expect((await within(dialog()).findByRole('alert')).textContent).toBe(message);
    expect(parts.state.investigation.getState().record).toMatchObject({ status: 'closed', readOnly: true });
  });
});

