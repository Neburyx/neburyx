import { cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { choosePreset, failure, listOf, openBuiltIn, openPatterns, patternsWorkspace, selectAccount, settle, CONNECTED, PRESETS, SHARED_ADDRESSES, setNumber, setWindow, chooseWindow } from './patterns-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const run = (): HTMLElement => screen.getByRole('button', { name: 'Run pattern' });
const labels = (): string[] => [...document.querySelectorAll('.patterns-panel .supernode-label')].map((node) => node.textContent ?? '');

describe('the form of a pattern', () => {
  it.each([
    ['Shared devices', ['Starting account', 'Window (UTC)', 'Min shared', 'Max matching accounts']],
    ['Shared addresses', ['Starting account', 'Window (UTC)', 'Min shared', 'Limit']],
    ['Connected accounts', ['Starting account', 'Direction', 'Hops', 'Window (UTC)', 'Limit']],
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
    expect(labels()).toEqual(['Anchor', 'Window (UTC)', 'Min shared', 'Limit']);
  });

  it('sends a window of two dates, a limit and a minimum, and sends nothing for a cleared window', async () => {
    const kit = await patternsWorkspace();
    await openBuiltIn();
    selectAccount(kit.state, 'acc-1');
    setWindow('2026-10-21', '2026-10-28');
    setNumber('Max matching accounts', '25');
    setNumber('Min shared', '2');
    await userEvent.click(run());
    await settle();
    expect(kit.sent[0]?.request.params).toEqual({ ref: { entityType: 'kind-a', stableId: 'acc-1' }, window: { from: '2026-10-21', to: '2026-10-28' }, limit: 25, minShared: 2 });
    chooseWindow('');
    await userEvent.click(run());
    await settle();
    expect(kit.sent[1]?.request.params).toEqual({ ref: { entityType: 'kind-a', stableId: 'acc-1' }, limit: 25, minShared: 2 });
  });

  it('refuses a reversed window and a limit below 1 with the reason and sends nothing', async () => {
    const kit = await patternsWorkspace();
    await openBuiltIn();
    selectAccount(kit.state, 'acc-1');
    setWindow('2026-10-28', '2026-10-21');
    setNumber('Max matching accounts', '0');
    await userEvent.click(run());
    expect(screen.getByText('The end date is before the start date.')).toBeTruthy();
    expect(screen.getByText(/Enter a whole number of 1 or more/)).toBeTruthy();
    expect(kit.sent).toHaveLength(0);
  });

  it('keeps every field as filled after INVALID_REQUEST and says it in words', async () => {
    const kit = await patternsWorkspace({ run: async () => ({ ok: false, failure: failure('INVALID_REQUEST') }) });
    await openBuiltIn();
    selectAccount(kit.state, 'acc-1');
    setNumber('Max matching accounts', '7');
    await userEvent.click(run());
    await settle();
    expect(screen.getAllByRole('alert')[0]?.textContent).toContain('The server did not accept this request.');
    expect(screen.getByLabelText('Max matching accounts (number)')).toHaveProperty('value', '7');
  });

  it('is built the same for every preset of the list', () => {
    expect(PRESETS).toContain(CONNECTED);
  });

  it('offers the window as a select: any time, the last 7, 14, 30 and 90 days and a range of dates, whose closed state reads as the range', async () => {
    const kit = await patternsWorkspace();
    await openBuiltIn();
    selectAccount(kit.state, 'acc-1');
    const select = screen.getByLabelText('Window (UTC)');
    expect([...select.querySelectorAll('option')].map((option) => option.textContent)).toEqual(['Any time', 'Last 7 days', 'Last 14 days', 'Last 30 days', 'Last 90 days', 'Custom range…']);
    expect(screen.queryByLabelText('Window (UTC): from')).toBeNull();
    chooseWindow('days:14');
    await userEvent.click(run());
    await settle();
    expect(kit.sent[0]?.request.params).toEqual({ ref: { entityType: 'kind-a', stableId: 'acc-1' }, window: { days: 14 } });
    setWindow('2026-10-21', '2026-10-28');
    expect(screen.getByLabelText('Window (UTC)').querySelector('option[value="custom"]')?.textContent).toBe('21–28 Oct 2026');
    await userEvent.click(run());
    await settle();
    expect(kit.sent[1]?.request.params).toEqual({ ref: { entityType: 'kind-a', stableId: 'acc-1' }, window: { from: '2026-10-21', to: '2026-10-28' } });
    chooseWindow('days:7');
    expect(screen.queryByLabelText('Window (UTC): from')).toBeNull();
    await userEvent.click(run());
    await settle();
    expect(kit.sent[2]?.request.params).toEqual({ ref: { entityType: 'kind-a', stableId: 'acc-1' }, window: { days: 7 } });
  });

  it('offers a number field as a select of steps with Custom for a number of one’s own, and says a custom number that is not whole', async () => {
    const kit = await patternsWorkspace();
    await openBuiltIn();
    selectAccount(kit.state, 'acc-1');
    const select = screen.getByLabelText('Max matching accounts');
    expect([...select.querySelectorAll('option')].map((option) => option.textContent).slice(0, 2)).toEqual(['Default', '1']);
    expect([...select.querySelectorAll('option')].at(-1)?.textContent).toBe('Custom…');
    setNumber('Max matching accounts', '25');
    await userEvent.click(run());
    await settle();
    expect(kit.sent[0]?.request.params).toMatchObject({ limit: 25 });
    expect(screen.queryByLabelText('Max matching accounts (number)')).toBeNull();
    setNumber('Max matching accounts', '37');
    expect(screen.getByLabelText('Max matching accounts')).toHaveProperty('value', 'custom');
    await userEvent.click(run());
    await settle();
    expect(kit.sent[1]?.request.params).toMatchObject({ limit: 37 });
    setNumber('Max matching accounts', '2.5');
    await userEvent.click(run());
    await settle();
    expect(kit.sent).toHaveLength(2);
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    fireEvent.change(select, { target: { value: '' } });
    expect(screen.queryByLabelText('Max matching accounts (number)')).toBeNull();
    await userEvent.click(run());
    await settle();
    expect(kit.sent[2]?.request.params).not.toHaveProperty('limit');
  });

  it('shows a value the list does not hold, such as the limit the source asked for, in the number field of Custom', async () => {
    const kit = await patternsWorkspace({ run: async () => ({ ok: false, failure: failure('QUERY_BUDGET_EXCEEDED', { maxPage: 33 }) }) });
    await openBuiltIn();
    selectAccount(kit.state, 'acc-1');
    setNumber('Max matching accounts', '50');
    await userEvent.click(run());
    await settle();
    expect(screen.getByLabelText('Max matching accounts')).toHaveProperty('value', 'custom');
    expect(screen.getByLabelText('Max matching accounts (number)')).toHaveProperty('value', '33');
  });

  it.each([['Any time', ''], ['the last 7 days', 'days:7']])('takes the error of a reversed range away when the window is changed to %s', async (_name, choice) => {
    const kit = await patternsWorkspace();
    await openBuiltIn();
    selectAccount(kit.state, 'acc-1');
    setWindow('2026-10-28', '2026-10-21');
    await userEvent.click(run());
    await settle();
    expect(screen.getByText('The end date is before the start date.')).toBeTruthy();
    expect(screen.getByLabelText('Window (UTC)').getAttribute('aria-invalid')).toBe('true');
    chooseWindow(choice);
    expect(screen.queryByText('The end date is before the start date.')).toBeNull();
    expect(screen.getByLabelText('Window (UTC)').getAttribute('aria-invalid')).toBe('false');
  });
});
