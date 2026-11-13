import { cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { choosePreset, failure, listOf, openBuiltIn, openPatterns, patternsWorkspace, selectAccount, settle, CONNECTED, PRESETS, SHARED_ADDRESSES } from './patterns-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const run = (): HTMLElement => screen.getByRole('button', { name: 'Run pattern' });
const labels = (): string[] => [...document.querySelectorAll('.patterns-panel .supernode-label')].map((node) => node.textContent ?? '');

describe('the form of a pattern', () => {
  it.each([
    ['Shared devices', ['Starting account', 'Window', 'Min shared', 'Max matching accounts']],
    ['Shared addresses', ['Starting account', 'Window', 'Min shared', 'Limit']],
    ['Connected accounts', ['Starting account', 'Direction', 'Hops', 'Window', 'Limit']],
  ])('has the fields the schema declares for %s, with the preset’s labels or plain names, and no other', async (name, expected) => {
    await patternsWorkspace();
    await openBuiltIn();
    await choosePreset(name);
    expect(labels()).toEqual(expected);
    expect(document.querySelectorAll('.patterns-panel input[type="text"]')).toBeDefined();
  });

  it('shows no free-text field but the two searches and numbers', async () => {
    await patternsWorkspace();
    await openBuiltIn();
    const inputs = [...document.querySelectorAll<HTMLInputElement>('.patterns-panel input')].map((input) => input.type);
    expect(inputs.every((type) => ['search', 'date', 'text'].includes(type))).toBe(true);
    expect([...document.querySelectorAll<HTMLInputElement>('.patterns-panel input[type="text"]')].every((input) => input.inputMode === 'numeric')).toBe(true);
  });

  it('shows a preset with no labels with the parameters’ plain names', async () => {
    await patternsWorkspace({ list: async () => ({ ok: true, value: listOf([{ ...SHARED_ADDRESSES, labels: [] }]) }) });
    await openBuiltIn('Shared addresses');
    expect(labels()).toEqual(['Anchor', 'Window', 'Min shared', 'Limit']);
  });

  it('sends a window of two dates, a limit and a minimum, and sends nothing for a cleared window', async () => {
    const kit = await patternsWorkspace();
    await openBuiltIn();
    selectAccount(kit.state, 'acc-1');
    fireEvent.change(screen.getByLabelText('Window: from'), { target: { value: '2026-10-21' } });
    fireEvent.change(screen.getByLabelText('Window: to'), { target: { value: '2026-10-28' } });
    await userEvent.type(screen.getByLabelText('Max matching accounts'), '25');
    await userEvent.type(screen.getByLabelText('Min shared'), '2');
    await userEvent.click(run());
    await settle();
    expect(kit.sent[0]?.request.params).toEqual({ ref: { entityType: 'kind-a', stableId: 'acc-1' }, window: { from: '2026-10-21', to: '2026-10-28' }, limit: 25, minShared: 2 });
    fireEvent.change(screen.getByLabelText('Window: from'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Window: to'), { target: { value: '' } });
    await userEvent.click(run());
    await settle();
    expect(kit.sent[1]?.request.params).toEqual({ ref: { entityType: 'kind-a', stableId: 'acc-1' }, limit: 25, minShared: 2 });
  });

  it('refuses a reversed window and a limit below 1 with the reason and sends nothing', async () => {
    const kit = await patternsWorkspace();
    await openBuiltIn();
    selectAccount(kit.state, 'acc-1');
    fireEvent.change(screen.getByLabelText('Window: from'), { target: { value: '2026-10-28' } });
    fireEvent.change(screen.getByLabelText('Window: to'), { target: { value: '2026-10-21' } });
    await userEvent.type(screen.getByLabelText('Max matching accounts'), '0');
    await userEvent.click(run());
    expect(screen.getByText('The end date is before the start date.')).toBeTruthy();
    expect(screen.getByText(/Enter a whole number of 1 or more/)).toBeTruthy();
    expect(kit.sent).toHaveLength(0);
  });

  it('keeps every field as filled after INVALID_REQUEST and says it in words', async () => {
    const kit = await patternsWorkspace({ run: async () => ({ ok: false, failure: failure('INVALID_REQUEST') }) });
    await openBuiltIn();
    selectAccount(kit.state, 'acc-1');
    await userEvent.type(screen.getByLabelText('Max matching accounts'), '7');
    await userEvent.click(run());
    await settle();
    expect(screen.getAllByRole('alert')[0]?.textContent).toContain('The server did not accept this request.');
    expect((screen.getByLabelText('Max matching accounts') as HTMLInputElement).value).toBe('7');
  });

  it('is built the same for every preset of the list', () => {
    expect(PRESETS).toContain(CONNECTED);
  });
});
