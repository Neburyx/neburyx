import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { savedPatternSchema, type PatternListResponse, type SavedPattern } from '@neburyx/contracts';
import type { ApiResult } from '../../api/client.js';
import { failure, listed, settle } from '../patterns-kit.js';
import { runButton, runWorkspace, validPattern, afterDebounce } from '../builder/builder-kit.js';

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
const saveButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Save pattern' }) as HTMLButtonElement;
const dialog = () => within(screen.getByRole('dialog'));
const calls = (kit: Awaited<ReturnType<typeof runWorkspace>>, method: string) => kit.patternCalls.filter((call) => call.method === method);
const nameField = (): HTMLInputElement => dialog().getByLabelText('Name') as HTMLInputElement;
const submit = async (): Promise<void> => {
  await userEvent.click(dialog().getByRole('button', { name: 'Save pattern' }));
  await settle();
};

describe('saving a built pattern', () => {
  it('disables Save pattern with its reason until the pattern is whole and valid', async () => {
    await runWorkspace();
    expect(saveButton().disabled).toBe(true);
    expect(screen.getAllByText('Complete the pattern first.').length).toBeGreaterThan(0);
    await validPattern();
    expect(saveButton().disabled).toBe(false);
  });

  it('opens a dialog with the name focused, what is stored, the path, the ask-each-time choice and the visibility, and gives the focus back on Cancel', async () => {
    await runWorkspace();
    await validPattern();
    await userEvent.click(saveButton());
    expect(document.activeElement).toBe(nameField());
    expect(nameField().value).toBe('N-A → r-1 → N-B');
    expect(dialog().getByText('Saves the pattern and its parameters, never query text. Running it applies your own access and limits.')).toBeTruthy();
    expect((dialog().getByRole('checkbox', { name: 'Ask for the starting entity each time' }) as HTMLInputElement).checked).toBe(true);
    expect((dialog().getByRole('radio', { name: 'Only me' }) as HTMLInputElement).checked).toBe(true);
    expect(dialog().getByRole('radio', { name: 'Everyone on this source' })).toBeTruthy();
    await userEvent.click(dialog().getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(saveButton());
  });

  it('saves with the source, the kind, the trimmed name and the definition, holds no starting entity while the choice stays, reads the list again and says so', async () => {
    const kit = await runWorkspace({ patterns: { savePattern: async () => ({ ok: true, value: stored() }) } });
    await validPattern();
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
    await validPattern();
    await userEvent.click(saveButton());
    await userEvent.click(dialog().getByRole('checkbox', { name: 'Ask for the starting entity each time' }));
    await submit();
    expect(calls(kit, 'savePattern')[0]?.args[0]).toMatchObject({ anchor: { entityType: 'n-a', stableId: 'x-1' } });
  });

  it('makes the choice checked and disabled, with a sentence, when no starting entity is chosen', async () => {
    await runWorkspace({ opened: null, nodes: [] });
    await validPattern();
    await userEvent.click(saveButton());
    const box = dialog().getByRole('checkbox', { name: 'Ask for the starting entity each time' }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(dialog().getByText('No starting entity is chosen, so the pattern will ask for one each time.')).toBeTruthy();
  });

  it('sends nothing for an empty name or one over 100 characters, and says the limit', async () => {
    const kit = await runWorkspace({ patterns: { savePattern: async () => ({ ok: true, value: stored() }) } });
    await validPattern();
    await userEvent.click(saveButton());
    await userEvent.clear(nameField());
    expect(dialog().getByRole('alert').textContent).toBe('Enter a name of 1 to 100 characters.');
    expect((dialog().getByRole('button', { name: 'Save pattern' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(nameField(), { target: { value: 'x'.repeat(101) } });
    expect((dialog().getByRole('button', { name: 'Save pattern' }) as HTMLButtonElement).disabled).toBe(true);
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
    await validPattern();
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
    await validPattern();
    await userEvent.click(saveButton());
    await userEvent.click(dialog().getByRole('radio', { name: 'Everyone on this source' }));
    await submit();
    expect(calls(kit, 'changePattern')[0]?.args.slice(0, 2)).toEqual([NEW_ID, { expectedVersion: 1, visibility: 'shared' }]);
    cleanup();
    document.body.replaceChildren();
    shareAnswer = { ok: false, failure: failure('INVALID_REQUEST', { reason: 'pattern-personal-condition' }) };
    await runWorkspace({ patterns: { savePattern: async () => ({ ok: true, value: stored() }), changePattern: async () => shareAnswer } });
    await validPattern();
    await userEvent.click(saveButton());
    await userEvent.click(dialog().getByRole('radio', { name: 'Everyone on this source' }));
    await submit();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/Pattern saved, but not shared\..*personal data/);
  });
});

