import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { draftSyncOf } from '../draft/draft-sync.js';
import { elementKey } from '../state/keys.js';
import { ref } from '../state/test-data.js';
import { createSlotRegistry } from '../workspace/slots.js';
import { registerBuiltInSlots } from '../workspace/built-in-slots.js';
import { clientWith, me, renderApp, source } from '../test-utils.js';
import { failure, INVESTIGATION_ID, rig, SAVED_AT, savedAnswer, TITLE, type SaveViewCall } from './view-fixtures.js';

afterEach(cleanup);

type Rig = ReturnType<typeof rig>;

function shown(options: Parameters<typeof rig>[0] = {}) {
  const base = clientWith({ me: me(), sources: [source('demo', { alias: 'fincrime' })] });
  const parts = rig({ ...options, base });
  const slots = createSlotRegistry();
  registerBuiltInSlots(slots);
  const app = renderApp(`/explore/${INVESTIGATION_ID}`, parts.client, parts.state, slots);
  return { ...parts, app };
}

const saveControl = async () => screen.findByRole('button', { name: 'Save' });
const dialog = () => screen.getByRole('dialog', { name: 'Save investigation' });
const submitButton = () => within(dialog()).getByRole('button', { name: 'Save investigation' });
const statusText = (): string => within(dialog()).getAllByRole('status').map((region) => region.textContent).join('');
const nameInput = () => within(dialog()).getByRole('textbox', { name: 'Name' });
const noteInput = () => within(dialog()).getByRole('textbox', { name: 'Note (optional)' });

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await saveControl());
  return dialog();
}

describe('the Save investigation dialog', () => {
  it('shows the fields, the list of what is saved, the two statements and both buttons, with the source, the title and the draft note filled in', async () => {
    const user = userEvent.setup();
    shown({ notes: 'last note' });
    await open(user);
    expect((nameInput() as HTMLInputElement).value).toBe(TITLE);
    expect((noteInput() as HTMLTextAreaElement).value).toBe('last note');
    const view = within(dialog());
    expect(view.getByText('View settings only · no source data is copied')).toBeTruthy();
    expect(view.getByText('A saved view stores the view, not the data; reopening reads the graph again.')).toBeTruthy();
    const list = view.getByRole('region', { name: 'What is saved' });
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['✓Source · fincrime'.replace('✓', ''), 'Visible and hidden items', 'Filters', 'Positions', 'Notes']);
    expect(view.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(submitButton()).toBeTruthy();
  });

  it('puts the hint under both inputs and ties each to its input', async () => {
    const user = userEvent.setup();
    shown();
    await open(user);
    for (const input of [nameInput(), noteInput()]) {
      const described = (input.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent);
      expect(described).toContain("Don't type customer names; others may see this text.");
    }
  });

  it('allows a note of 10,000 characters counted as characters and refuses one more, with the message tied to the note', async () => {
    const user = userEvent.setup();
    shown();
    await open(user);
    const described = (): string => (noteInput().getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    await user.click(noteInput());
    await user.paste('\u{1f642}'.repeat(10_000));
    expect((submitButton() as HTMLButtonElement).disabled).toBe(false);
    expect(described()).not.toContain('at most 10,000');
    await user.paste('x');
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
    expect(described()).toContain('A note is at most 10,000 characters.');
    expect(noteInput().getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById((noteInput().getAttribute('aria-describedby') ?? '').split(' ').at(-1) ?? '')?.getAttribute('role')).toBe('status');
  });

  it('opens with the focus in Name, closes on Esc without saving, and gives the focus back to Save', async () => {
    const user = userEvent.setup();
    const { saves } = shown();
    await open(user);
    expect(document.activeElement).toBe(nameInput());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(await saveControl());
    expect(saves).toEqual([]);
  });

  it('keeps the focus inside while Tab goes round, in both directions', async () => {
    const user = userEvent.setup();
    shown();
    await open(user);
    const inside = (): boolean => dialog().contains(document.activeElement);
    for (let press = 0; press < 12; press += 1) {
      await user.tab();
      expect(inside()).toBe(true);
    }
    for (let press = 0; press < 12; press += 1) {
      await user.tab({ shift: true });
      expect(inside()).toBe(true);
    }
  });

  it('saves on Enter in Name, closes, and shows "Saved 09:42 UTC" with the title unchanged', async () => {
    const user = userEvent.setup();
    const { saves } = shown();
    await open(user);
    await user.type(noteInput(), 'first pass');
    await user.click(nameInput());
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(saves).toHaveLength(1);
    expect(saves[0]?.body).toEqual({ name: TITLE, notes: 'first pass' });
    expect(within(screen.getByRole('banner', { name: 'Investigation' })).getByText('Saved 09:42 UTC')).toBeTruthy();
    expect(document.activeElement).toBe(await saveControl());
  });

  it('sends a changed name as the title, and shows the new title in the header', async () => {
    const user = userEvent.setup();
    const { saves } = shown();
    await open(user);
    await user.clear(nameInput());
    await user.type(nameInput(), 'Ring of five');
    await user.click(submitButton());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(saves[0]?.body).toEqual({ name: 'Ring of five', notes: null, title: 'Ring of five', expectedInvestigationVersion: 3 });
    expect(screen.getByRole('heading', { level: 1, name: 'Ring of five' })).toBeTruthy();
  });

  it('disables Save investigation when Name is empty', async () => {
    const user = userEvent.setup();
    shown();
    await open(user);
    await user.clear(nameInput());
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
    await user.type(nameInput(), 'a');
    expect((submitButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('says a name is at most 120 characters, keeps Save disabled until it fits, and ties the message to Name', async () => {
    const user = userEvent.setup();
    const long = 'T'.repeat(150);
    const parts = shown();
    parts.state.describeInvestigation({ title: long, caseRef: null, status: 'open', readOnly: false, version: 3, save: { kind: 'unsaved' } });
    await open(user);
    expect((nameInput() as HTMLInputElement).value).toBe(long);
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
    const message = (): string => (nameInput().getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(message()).toContain('A view name is at most 120 characters.');
    expect(document.getElementById((nameInput().getAttribute('aria-describedby') ?? '').split(' ').at(-1) ?? '')?.getAttribute('role')).toBe('status');
    expect(nameInput().getAttribute('aria-invalid')).toBe('true');
    await user.type(nameInput(), '{Backspace>31/}');
    expect((nameInput() as HTMLInputElement).value).toHaveLength(119);
    expect((submitButton() as HTMLButtonElement).disabled).toBe(false);
    expect(message()).not.toContain('at most 120');
  });

  it('allows one request while a save is in flight, and gives Save back when it fails, with the error in the status region', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const parts = shown({ saveView: () => failure('INTERNAL_ERROR') });
    const original = parts.client.saveView;
    Object.assign(parts.client, { saveView: async (...args: Parameters<typeof original>) => (await gate, original(...args)) });
    await open(user);
    await user.click(submitButton());
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
    expect(statusText()).toBe('Saving…');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeNull();
    await act(async () => release());
    await waitFor(() => expect(statusText()).toBe("Couldn't save the view. Try again."));
    expect((submitButton() as HTMLButtonElement).disabled).toBe(false);
    expect(parts.saves).toHaveLength(1);
  });

  it('says the investigation was renamed elsewhere, keeps the dialog open, ties the message to Name and offers Reload', async () => {
    const user = userEvent.setup();
    shown({ saveView: () => failure('CONFLICT') });
    await open(user);
    await user.type(nameInput(), '!');
    await user.click(submitButton());
    await waitFor(() => expect(within(dialog()).getByRole('button', { name: 'Reload' })).toBeTruthy());
    const described = (nameInput().getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(described).toContain('This investigation was renamed elsewhere. Reload to continue.');
  });

  it('closes the dialog and shows the changed-in-another-tab banner when the draft version is stale', async () => {
    const user = userEvent.setup();
    const parts = shown({ saveView: () => failure('CONFLICTED_VIEW_VERSION') });
    await open(user);
    await user.click(submitButton());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(draftSyncOf(parts.state, parts.client).status.getState()).toEqual({ kind: 'conflict' });
    expect((await screen.findAllByText('This investigation changed in another tab.')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('writes the draft first and sends no save when that write fails, with the error shown in the dialog', async () => {
    const user = userEvent.setup();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const parts = shown({ saveDraft: async () => failure('INTERNAL_ERROR') });
      parts.state.presentation.setPosition(elementKey(ref('demo', 'type-a', 'A')), { x: 3, y: 3 });
      await open(user);
      await user.click(submitButton());
      await waitFor(() => expect(statusText()).toBe("Couldn't save the view. Try again."));
      expect(parts.saves).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries the investigation shown and its draft version in the save', async () => {
    const user = userEvent.setup();
    const calls: SaveViewCall[] = [];
    const { drafts } = shown({ saveView: (call) => (calls.push(call), savedAnswer(call)) });
    await open(user);
    await user.click(submitButton());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ id: INVESTIGATION_ID, draftVersion: 1 + drafts.length });
    expect(SAVED_AT).toBe('2026-11-10T09:42:00.000Z');
  });
});

export type { Rig };
