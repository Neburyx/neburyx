import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { savedPatternSchema, type PatternListResponse, type SavedPattern } from '@neburyx/contracts';
import type { ApiResult } from '../../api/client.js';
import { failure, listed, settle } from '../patterns-kit.js';
import { previewed, runWorkspace, validPattern } from '../run/run-kit.js';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const NEW_ID = '0192f000-0000-7000-8000-0000000000b1';
const stored = (overrides: Partial<SavedPattern> = {}): SavedPattern => savedPatternSchema.parse({ id: NEW_ID, sourceId: 'a', name: 'Mine', askForStartingEntity: true, anchor: null, visibility: 'private', lastRunAt: null, createdAt: '2026-11-12T10:00:00.000Z', updatedAt: '2026-11-12T10:00:00.000Z', version: 1, kind: 'definition', definition: {}, ...overrides });
const empty = (): ApiResult<PatternListResponse> => ({ ok: true, value: { items: [], nextCursor: null } });
const DEFINITION = { anchorType: 'n-a', steps: [{ relationshipTypes: ['r-1'], direction: 'out', arrivesAt: 'n-b' }] };
const saveButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Save pattern…' }) as HTMLButtonElement;
const dialog = () => within(screen.getByRole('dialog'));
const calls = (kit: Awaited<ReturnType<typeof runWorkspace>>, method: string) => kit.patternCalls.filter((call) => call.method === method);
const nameField = (): HTMLInputElement => dialog().getByLabelText('Name') as HTMLInputElement;
const saveInDialog = (): HTMLButtonElement => dialog().getByRole('button', { name: 'Save' }) as HTMLButtonElement;
const submit = async (): Promise<void> => {
  await userEvent.click(saveInDialog());
  await settle();
};

describe('saving a built pattern', () => {
  it('offers Save pattern… on the preview, which the editor opens only for a pattern that is whole and valid', async () => {
    await runWorkspace();
    expect(screen.queryByRole('button', { name: 'Save pattern…' })).toBeNull();
    expect((screen.getByRole('button', { name: /^Preview/ }) as HTMLButtonElement).disabled).toBe(true);
    await validPattern();
    await userEvent.click(screen.getByRole('button', { name: /^Preview/ }));
    await settle();
    expect(saveButton().disabled).toBe(false);
  });

  it('opens the dialog of PB16: the name focused with its rule line, Who can use it with the two options and their sublines, Cancel and Save, and gives the focus back on Cancel', async () => {
    await runWorkspace();
    await previewed();
    await userEvent.click(saveButton());
    expect(dialog().getByRole('heading', { name: 'Save pattern' })).toBeTruthy();
    expect(document.activeElement).toBe(nameField());
    expect(nameField().value).toBe('N-A → r-1 → N-B');
    expect(dialog().getByText('1 to 100 characters. Names are unique among your patterns on this source.')).toBeTruthy();
    expect(nameField().getAttribute('aria-describedby')).toBe(dialog().getByText(/^1 to 100 characters/).id);
    expect(dialog().getByRole('group', { name: 'Who can use it' })).toBeTruthy();
    const only = dialog().getByRole('radio', { name: 'Only me' }) as HTMLInputElement;
    expect(only.checked).toBe(true);
    expect(only.getAttribute('aria-describedby')).toBe(dialog().getByText('Private. It appears under My patterns.').id);
    expect(dialog().getByRole('radio', { name: 'Everyone on this source' }).getAttribute('aria-describedby')).toBe(dialog().getByText('Others can run and copy it. They cannot change or delete it.').id);
    expect((dialog().getByRole('checkbox', { name: 'Ask for the starting entity each time' }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(dialog().getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(saveButton());
  });

  it('saves with the source, the kind, the trimmed name and the definition, holds no starting entity while the choice stays, reads the list again and says so', async () => {
    const kit = await runWorkspace({ patterns: { savePattern: async () => ({ ok: true, value: stored() }) } });
    await previewed();
    await userEvent.click(saveButton());
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), '  Mine ');
    await submit();
    expect(calls(kit, 'savePattern')).toHaveLength(1);
    expect(calls(kit, 'savePattern')[0]?.args[0]).toEqual({ sourceId: 'a', kind: 'definition', name: 'Mine', definition: DEFINITION });
    expect(calls(kit, 'listPatterns').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Pattern saved.')).toBeTruthy();
  });

  it('holds the starting entity chosen in the run section when the choice is cleared', async () => {
    const kit = await runWorkspace({ patterns: { savePattern: async () => ({ ok: true, value: stored() }) } });
    await previewed();
    await userEvent.click(saveButton());
    await userEvent.click(dialog().getByRole('checkbox', { name: 'Ask for the starting entity each time' }));
    await submit();
    expect(calls(kit, 'savePattern')[0]?.args[0]).toMatchObject({ anchor: { entityType: 'n-a', stableId: 'x-1' } });
  });

  it('makes the choice checked and disabled, with a sentence, when no starting entity is chosen', async () => {
    await runWorkspace({ opened: null, nodes: [] });
    await previewed();
    await userEvent.click(saveButton());
    const box = dialog().getByRole('checkbox', { name: 'Ask for the starting entity each time' }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(dialog().getByText('No starting entity is chosen, so the pattern will ask for one each time.')).toBeTruthy();
  });

  it('sends nothing for an empty name or one over 100 characters, and says the limit', async () => {
    const kit = await runWorkspace({ patterns: { savePattern: async () => ({ ok: true, value: stored() }) } });
    await previewed();
    await userEvent.click(saveButton());
    await userEvent.clear(nameField());
    expect(dialog().getByRole('alert').textContent).toBe('Enter a name of 1 to 100 characters.');
    expect((dialog().getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(nameField(), { target: { value: 'x'.repeat(101) } });
    expect((dialog().getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(nameField().closest('form') as HTMLFormElement);
    await settle();
    expect(calls(kit, 'savePattern')).toHaveLength(0);
  });

  it.each([
    [{ code: 'INVALID_REQUEST', details: { reason: 'pattern-limit' } }, /already holds 200 saved patterns/],
    [{ code: 'INVALID_REQUEST', details: { reason: 'pattern-personal-condition' } }, /personal data/],
    [{ code: 'AUDIT_UNAVAILABLE' }, /could not be recorded/],
    [{ code: 'RATE_LIMITED' }, /Too many requests/],
  ])('keeps the dialog open with the name typed, says %j in words, and adds nothing to the list', async (refusal, text) => {
    const kit = await runWorkspace({ patterns: { savePattern: async () => ({ ok: false, failure: failure(refusal.code, 'details' in refusal ? refusal.details : undefined) }) } });
    await previewed();
    await userEvent.click(saveButton());
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), 'Mine');
    await submit();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(nameField().value).toBe('Mine');
    expect(dialog().getAllByRole('alert').map((entry) => entry.textContent).join(' ')).toMatch(text);
    expect(calls(kit, 'listPatterns')).toHaveLength(1);
  });

  it('saves private and then shares with the visibility and version alone, and says when the share was refused that the pattern is saved and private', async () => {
    let shareAnswer: ApiResult<SavedPattern> = { ok: true, value: stored({ version: 2, visibility: 'shared' }) };
    const kit = await runWorkspace({ patterns: { savePattern: async () => ({ ok: true, value: stored() }), changePattern: async () => shareAnswer } });
    await previewed();
    await userEvent.click(saveButton());
    await userEvent.click(dialog().getByRole('radio', { name: 'Everyone on this source' }));
    await submit();
    expect(calls(kit, 'changePattern')[0]?.args.slice(0, 2)).toEqual([NEW_ID, { expectedVersion: 1, visibility: 'shared' }]);
    cleanup();
    document.body.replaceChildren();
    shareAnswer = { ok: false, failure: failure('INVALID_REQUEST', { reason: 'pattern-personal-condition' }) };
    await runWorkspace({ patterns: { savePattern: async () => ({ ok: true, value: stored() }), changePattern: async () => shareAnswer } });
    await previewed();
    await userEvent.click(saveButton());
    await userEvent.click(dialog().getByRole('radio', { name: 'Everyone on this source' }));
    await submit();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/Pattern saved, but not shared\..*personal data/);
  });
});

describe('the refusals of a save, and the dialog around them', () => {
  const taken = (): ApiResult<SavedPattern> => ({ ok: false, failure: failure('CONFLICT', { reason: 'pattern-name-taken' }) });

  it('says "already used" when the name is taken, keeps the dialog open with the name, waits for another name and does not read the list again', async () => {
    let answer: ApiResult<SavedPattern> = taken();
    const kit = await runWorkspace({ patterns: { savePattern: async () => answer } });
    await previewed();
    await userEvent.click(saveButton());
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), 'Mine');
    await submit();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(nameField().value).toBe('Mine');
    expect(dialog().getByRole('alert').textContent).toBe('This name is already used on this source. Choose another.');
    expect(nameField().getAttribute('aria-invalid')).toBe('true');
    expect(saveInDialog().disabled).toBe(true);
    expect(calls(kit, 'listPatterns')).toHaveLength(1);
    answer = { ok: true, value: stored({ name: 'Other' }) };
    await userEvent.type(nameField(), '2');
    expect(saveInDialog().disabled).toBe(false);
    await submit();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls(kit, 'savePattern')).toHaveLength(2);
  });

  it('keeps the words of "changed elsewhere" for a CONFLICT with no reason, apart from the name being used', async () => {
    await runWorkspace({ patterns: { savePattern: async () => ({ ok: false, failure: failure('CONFLICT') }) } });
    await previewed();
    await userEvent.click(saveButton());
    await submit();
    const said = dialog().getByRole('alert').textContent ?? '';
    expect(said).toMatch(/changed since you read the list/);
    expect(said).not.toMatch(/already used/);
  });

  it('keeps the focus inside the dialog on Tab and Shift+Tab, closes on Escape and gives the focus back to Save pattern…', async () => {
    await runWorkspace();
    await previewed();
    await userEvent.click(saveButton());
    const inside = (): boolean => screen.getByRole('dialog').contains(document.activeElement);
    for (let press = 0; press < 12; press += 1) {
      await userEvent.tab();
      expect(inside()).toBe(true);
    }
    await userEvent.tab({ shift: true });
    expect(inside()).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(saveButton());
  });

  it('hands the name of the saved pattern to the screen, so that the heading says it and Save pattern… goes', async () => {
    await runWorkspace({ patterns: { savePattern: async () => ({ ok: true, value: stored({ name: 'Mine' }) }) } });
    await previewed();
    expect(document.querySelector('.patterns-subhead')?.textContent).toBe('Draft · not saved');
    await userEvent.click(saveButton());
    await submit();
    expect(document.querySelector('.patterns-subhead')?.textContent).toBe('Mine');
    expect(screen.queryByRole('button', { name: 'Save pattern…' })).toBeNull();
  });

  it('closes at once with the X after the draft is saved from its preview, since nothing is lost', async () => {
    await runWorkspace({ patterns: { savePattern: async () => ({ ok: true, value: stored({ name: 'Mine' }) }) } });
    await previewed();
    await userEvent.click(saveButton());
    await submit();
    await userEvent.click(screen.getByRole('button', { name: 'Close Patterns' }));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Preview pattern' })).toBeNull();
  });
});
