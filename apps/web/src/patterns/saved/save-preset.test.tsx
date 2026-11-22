import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { savedPatternSchema, type SavedPattern } from '@neburyx/contracts';
import type { ApiResult } from '../../api/client.js';
import { failure, listOf, openBuiltIn, patternsWorkspace, selectAccount, settle, SHARED_DEVICES, setNumber, setWindow } from '../patterns-kit.js';
import { refusalText } from './saved-copy.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const NEW_ID = '0192f000-0000-7000-8000-0000000000c1';
const stored = (overrides: Record<string, unknown> = {}): SavedPattern =>
  savedPatternSchema.parse({ id: NEW_ID, sourceId: 'a', name: 'Shared devices', askForStartingEntity: true, anchor: null, visibility: 'private', lastRunAt: null, createdAt: '2026-11-12T10:00:00.000Z', updatedAt: '2026-11-12T10:00:00.000Z', version: 1, kind: 'preset-run', presetId: 'shared-devices', templateId: 'shared-attribute', templateVersion: 1, params: {}, ...overrides });
const saveButton = (): HTMLElement => screen.getByRole('button', { name: /^Save pattern$/ });
const dialog = () => within(screen.getByRole('dialog'));
const nameField = (): HTMLElement => dialog().getByLabelText('Name');
const saveInDialog = (): HTMLElement => dialog().getByRole('button', { name: 'Save pattern' });
const submit = async (): Promise<void> => {
  await userEvent.click(saveInDialog());
  await settle();
};
const fill = async (): Promise<void> => {
  setWindow('2026-10-21', '2026-10-28');
  setNumber('Max matching accounts', '25');
};
const saves = (kit: Awaited<ReturnType<typeof patternsWorkspace>>) => kit.patternCalls.filter((call) => call.method === 'savePattern');
const signalOf = (kit: Awaited<ReturnType<typeof patternsWorkspace>>): AbortSignal => {
  const signal = saves(kit)[0]?.args[1];
  if (!(signal instanceof AbortSignal)) throw new Error('the save carried no signal');
  return signal;
};
const ok = async (): Promise<ApiResult<SavedPattern>> => ({ ok: true, value: stored() });

describe('saving a built-in run from its form', () => {
  it('offers Save pattern beside Run, enabled before any run and with no starting entity chosen', async () => {
    await patternsWorkspace({ opened: null });
    await openBuiltIn();
    expect(saveButton()).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Run pattern' })).toHaveProperty('disabled', true);
  });

  it('refuses an invalid form with its field errors, opens no dialog and sends nothing', async () => {
    const kit = await patternsWorkspace();
    await openBuiltIn();
    setWindow('2026-10-28', '2026-10-21');
    await userEvent.click(saveButton());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelectorAll('.patterns-error').length).toBeGreaterThan(0);
    expect(saves(kit)).toHaveLength(0);
  });

  it('opens the dialog with the name, the pattern with its version, the parameters in the form’s labels, the ask choice, who can use it and the sentence', async () => {
    await patternsWorkspace();
    await openBuiltIn();
    await fill();
    await userEvent.click(saveButton());
    expect(document.activeElement).toBe(nameField());
    expect(nameField()).toHaveProperty('value', 'Shared devices, 21–28 Oct 2026');
    expect(dialog().queryByText(/^1 to 100 characters/)).toBeNull();
    expect(dialog().getByText('Shared devices')).toBeTruthy();
    expect(dialog().getByText('v1')).toBeTruthy();
    const row = (label: string) => {
      const found = dialog().getByText(label).closest('div');
      if (found === null) throw new Error(`no row for ${label}`);
      return within(found);
    };
    expect(row('Window · UTC').getByText('21–28 Oct 2026')).toBeTruthy();
    expect(row('Max matching accounts').getByText('25')).toBeTruthy();
    expect(dialog().queryByText(/Min shared/)).toBeNull();
    expect(dialog().getByRole('group', { name: 'Visibility' })).toBeTruthy();
    expect(dialog().getByRole('radio', { name: 'Only me' })).toBeTruthy();
    expect(dialog().getByRole('radio', { name: 'Everyone on this source' })).toBeTruthy();
    expect(dialog().getByText('Saves the pattern and its parameters, never query text. Running it applies your own access and limits.')).toBeTruthy();
    expect(dialog().getByRole('checkbox', { name: 'Ask for the starting account each time' })).toHaveProperty('checked', true);
  });

  it('saves the preset and its parameters without the starting entity and without an anchor while the choice stays', async () => {
    const kit = await patternsWorkspace({ patterns: { savePattern: ok } });
    await openBuiltIn();
    selectAccount(kit.state, 'acc-1');
    await fill();
    await userEvent.click(saveButton());
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), '  Week ');
    await submit();
    expect(saves(kit)).toHaveLength(1);
    expect(saves(kit)[0]?.args[0]).toEqual({ sourceId: 'a', kind: 'preset-run', name: 'Week', presetId: 'shared-devices', params: { window: { from: '2026-10-21', to: '2026-10-28' }, limit: 25 } });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Pattern saved.')).toBeTruthy();
    expect(kit.patternCalls.filter((call) => call.method === 'listPatterns').length).toBeGreaterThanOrEqual(2);
  });

  it('holds the chosen entity as the anchor when the choice is cleared, and asks each time, forced, when none is chosen', async () => {
    const kit = await patternsWorkspace({ patterns: { savePattern: ok } });
    await openBuiltIn();
    selectAccount(kit.state, 'acc-1');
    await userEvent.click(saveButton());
    await userEvent.click(dialog().getByRole('checkbox', { name: 'Ask for the starting account each time' }));
    await submit();
    expect(saves(kit)[0]?.args[0]).toMatchObject({ anchor: { entityType: 'kind-a', stableId: 'acc-1' } });
    cleanup();
    const none = await patternsWorkspace({ opened: null, patterns: { savePattern: ok } });
    await openBuiltIn();
    await userEvent.click(saveButton());
    const ask = dialog().getByRole('checkbox', { name: 'Ask for the starting account each time' });
    expect(ask).toHaveProperty('checked', true);
    expect(ask).toHaveProperty('disabled', true);
    expect(dialog().getByText('No account is chosen, so the pattern will ask for one each time.')).toBeTruthy();
    await submit();
    expect(saves(none)[0]?.args[0]).not.toHaveProperty('anchor');
  });

  it('saves and then shares with Everyone on this source, and says saved but not shared when the share is refused', async () => {
    const kit = await patternsWorkspace({ patterns: { savePattern: ok, changePattern: async () => ({ ok: false, failure: failure('RATE_LIMITED') }) } });
    await openBuiltIn();
    await userEvent.click(saveButton());
    await userEvent.click(dialog().getByRole('radio', { name: 'Everyone on this source' }));
    await submit();
    expect(kit.patternCalls.find((call) => call.method === 'changePattern')?.args.slice(0, 2)).toEqual([NEW_ID, { expectedVersion: 1, visibility: 'shared' }]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/^Pattern saved, but not shared\./)).toBeTruthy();
  });

  it.each([
    ['the name taken', failure('CONFLICT', { reason: 'pattern-name-taken' }), 'This name is already used on this source. Choose another.'],
    ['the limit reached', failure('INVALID_REQUEST', { reason: 'pattern-limit', limit: 200 }), /200/],
  ])('keeps the dialog open with what was typed when the route refuses with %s', async (_name, refusal, sentence) => {
    await patternsWorkspace({ patterns: { savePattern: async () => ({ ok: false, failure: refusal }) } });
    await openBuiltIn();
    await userEvent.click(saveButton());
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), 'Keep me');
    await submit();
    expect(nameField()).toHaveProperty('value', 'Keep me');
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toMatch(sentence);
  });

  it('disables Save for an empty name, and Cancel and Escape close the dialog and give the focus back to Save pattern', async () => {
    const kit = await patternsWorkspace();
    await openBuiltIn();
    await userEvent.click(saveButton());
    await userEvent.clear(nameField());
    expect(saveInDialog()).toHaveProperty('disabled', true);
    await userEvent.click(dialog().getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(saveButton());
    await userEvent.click(saveButton());
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(saves(kit)).toHaveLength(0);
  });

  it('keeps Cancel off while the save is in flight and runs no callback when the dialog goes meanwhile', async () => {
    let release: (value: ApiResult<SavedPattern>) => void = () => undefined;
    const kit = await patternsWorkspace({ patterns: { savePattern: () => new Promise((resolve) => (release = resolve)) } });
    await openBuiltIn();
    await userEvent.click(saveButton());
    await userEvent.click(saveInDialog());
    expect(dialog().getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);
    expect(saves(kit)).toHaveLength(1);
    const signal = signalOf(kit);
    expect(signal.aborted).toBe(false);
    kit.unmount();
    expect(signal.aborted).toBe(true);
    release({ ok: true, value: stored() });
    await settle();
    expect(kit.patternCalls.filter((call) => call.method === 'changePattern')).toHaveLength(0);
  });

  it('aborts a save in flight and closes the dialog when the mask changes, and runs no share afterwards', async () => {
    let release: (value: ApiResult<SavedPattern>) => void = () => undefined;
    const kit = await patternsWorkspace({ patterns: { savePattern: () => new Promise((resolve) => (release = resolve)) } });
    await openBuiltIn();
    await userEvent.click(saveButton());
    await userEvent.click(dialog().getByRole('radio', { name: 'Everyone on this source' }));
    await userEvent.click(saveInDialog());
    const signal = signalOf(kit);
    act(() => kit.state.setMask(true));
    await settle();
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    release({ ok: true, value: stored() });
    await settle();
    expect(kit.patternCalls.filter((call) => call.method === 'changePattern')).toHaveLength(0);
  });

  it('leaves the form values and the result as they were across open, cancel and save', async () => {
    const kit = await patternsWorkspace({ patterns: { savePattern: ok } });
    await openBuiltIn();
    selectAccount(kit.state, 'acc-1');
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Run pattern' }));
    await settle();
    const resultBefore = document.querySelector('.patterns-result')?.innerHTML;
    expect(resultBefore).toBeDefined();
    await userEvent.click(saveButton());
    await userEvent.click(dialog().getByRole('button', { name: 'Cancel' }));
    await userEvent.click(saveButton());
    await submit();
    expect(screen.getByLabelText('Max matching accounts')).toHaveProperty('value', '25');
    expect(screen.getByLabelText('Window · UTC: from')).toHaveProperty('value', '2026-10-21');
    expect(document.querySelector('.patterns-result')?.innerHTML).toBe(resultBefore);
  });

  it('cuts a preset name longer than the limit of a name, and says a refusal with no reason in the generic words', async () => {
    const long = 'P'.repeat(130);
    const kit = await patternsWorkspace({ list: async () => ({ ok: true, value: listOf([{ ...SHARED_DEVICES, name: long }]) }), patterns: { savePattern: async () => ({ ok: false, failure: failure('INVALID_REQUEST') }) } });
    await openBuiltIn(long);
    await userEvent.click(saveButton());
    expect(nameField()).toHaveProperty('value', 'P'.repeat(100));
    await submit();
    expect(saves(kit)).toHaveLength(1);
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe(refusalText(failure('INVALID_REQUEST')));
  });

  it('keeps the dialog open on Escape while the save is in flight, and closes once it has answered', async () => {
    let release: (value: ApiResult<SavedPattern>) => void = () => undefined;
    await patternsWorkspace({ patterns: { savePattern: () => new Promise((resolve) => (release = resolve)) } });
    await openBuiltIn();
    await userEvent.click(saveButton());
    await userEvent.click(saveInDialog());
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeTruthy();
    release({ ok: true, value: stored() });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Pattern saved.')).toBeTruthy();
  });

  it('saves for everyone on the source and says the pattern was saved when the share goes through', async () => {
    const kit = await patternsWorkspace({ patterns: { savePattern: ok, changePattern: async () => ({ ok: true, value: stored({ visibility: 'shared', version: 2 }) }) } });
    await openBuiltIn();
    await userEvent.click(saveButton());
    await userEvent.click(dialog().getByRole('radio', { name: 'Everyone on this source' }));
    await submit();
    expect(kit.patternCalls.filter((call) => call.method === 'changePattern')).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Pattern saved.')).toBeTruthy();
  });

  it('reaches Save pattern by Tab after Run pattern with no starting entity, and opens the dialog with Enter', async () => {
    await patternsWorkspace({ opened: null });
    await openBuiltIn();
    const run = screen.getByRole('button', { name: 'Run pattern' });
    expect(run).toHaveProperty('disabled', true);
    screen.getByLabelText('Max matching accounts').focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(saveButton());
    await userEvent.keyboard('{Enter}');
    expect(dialog().getByRole('heading', { name: 'Save pattern' })).toBeTruthy();
    expect(document.activeElement).toBe(nameField());
  });

  it('shows the rule of a name only when the name is refused or does not fit', async () => {
    await patternsWorkspace({ patterns: { savePattern: async () => ({ ok: false, failure: failure('CONFLICT', { reason: 'pattern-name-taken' }) }) } });
    await openBuiltIn();
    await userEvent.click(saveButton());
    expect(dialog().queryByText(/^1 to 100 characters/)).toBeNull();
    await userEvent.clear(nameField());
    expect(dialog().getByText(/^1 to 100 characters/)).toBeTruthy();
    await userEvent.type(nameField(), 'Taken');
    expect(dialog().queryByText(/^1 to 100 characters/)).toBeNull();
    await submit();
    expect(dialog().getByText(/^1 to 100 characters/)).toBeTruthy();
  });

  it('puts Save pattern after the timeout label as a link', async () => {
    await patternsWorkspace();
    await openBuiltIn();
    const note = screen.getByText('5 s timeout');
    expect(note.compareDocumentPosition(saveButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(saveButton().className).toBe('link');
  });
});
