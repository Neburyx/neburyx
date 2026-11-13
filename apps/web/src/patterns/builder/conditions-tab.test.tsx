import { act, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceProfile } from '@neburyx/contracts';
import { settle } from '../patterns-kit.js';
import { addCondition, buildStep, chooseStart, cleanup, conditionRow, conditionsProfile, conditionsWorkspace, editRow, openBuilder, openStep, rowField, screen, stepCard, userEvent, within } from './builder-kit.js';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

/** The conditions mapping with the kinds the source now declares: c-b's properties and the rows k-1 and k-5 carry. */
function withKinds(): SourceProfile {
  const base = conditionsProfile();
  return {
    ...base,
    entityTypes: base.entityTypes.map((entity) => (entity.type === 'c-b' ? { ...entity, filterKinds: { 'b-name': 'text', 'b-count': 'number', 'b-secret': 'text' } } : entity)),
    relationshipTypes: base.relationshipTypes.map((row) => (row.type === 'k-1' ? { ...row, filterKinds: { 'q-size': 'number', 'q-when': 'dateTime' } } : row)),
  } as SourceProfile;
}

async function started(types: readonly string[], profile: SourceProfile = conditionsProfile(), mask = false) {
  const kit = await conditionsWorkspace({ profile: async () => ({ ok: true, value: profile }) });
  if (mask) act(() => kit.state.setMask(true));
  await settle();
  await openBuilder();
  await chooseStart('c-a');
  await buildStep(1, 'out', 'c-b', types);
  await openStep(1, 'Conditions');
  return kit;
}
const menuItems = (): string[] => screen.getAllByRole('menuitem').map((item) => item.textContent ?? '');
const openMenu = async (): Promise<void> => userEvent.click(within(stepCard(1)).getByRole('button', { name: '+ Add condition' }));

describe('the Conditions tab', () => {
  it('has a group for the arriving type and one for the relationship types, each with its count of the cap', async () => {
    await started(['k-1', 'k-2']);
    expect(within(stepCard(1)).getByRole('group', { name: 'Arriving C-B · 0 of 6' })).toBeTruthy();
    expect(within(stepCard(1)).getByRole('group', { name: 'k-1 or k-2 · 0 of 6' })).toBeTruthy();
    await addCondition(1);
    await userEvent.click(within(conditionRow(1, 1)).getByRole('button', { name: 'Done' }).closest('[role="group"]') === null ? document.body : document.body);
    expect(within(stepCard(1)).getByRole('group', { name: 'Arriving C-B · 1 of 6' })).toBeTruthy();
    expect(within(stepCard(1)).getByRole('tab', { name: 'Conditions · 1' })).toBeTruthy();
  });

  it('lists in the add menu the properties of the arriving type and of the relationship types, names only while the profile has no kinds', async () => {
    await started(['k-1']);
    await openMenu();
    expect(screen.getByRole('group', { name: 'On the arriving C-B' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'On k-1' })).toBeTruthy();
    expect(menuItems()).toEqual(['b-name', 'b-count', 'b-secret', 'q-size', 'q-when']);
  });

  it('shows the kind beside each property once the profile declares it', async () => {
    await started(['k-1'], withKinds());
    await openMenu();
    expect(menuItems()).toEqual(['b-nametext', 'b-countnumber', 'b-secrettext', 'q-sizenumber', 'q-whendate-time']);
  });

  it('writes a condition as one line with Edit and Remove, and opens it for editing in place', async () => {
    await started(['k-1']);
    await addCondition(1, 'b-count');
    fireEvent.change(rowField(1, 1, 'Value'), { target: { value: '12' } });
    await userEvent.click(within(conditionRow(1, 1)).getByRole('button', { name: 'Done' }));
    const row = within(conditionRow(1, 1));
    expect(row.getByText('b-count is 12')).toBeTruthy();
    expect(row.getByText('C-B')).toBeTruthy();
    expect(row.getByRole('button', { name: 'Edit condition: b-count is 12' })).toBeTruthy();
    await userEvent.click(row.getByRole('button', { name: 'Edit condition: b-count is 12' }));
    expect((rowField(1, 1, 'Value') as HTMLInputElement).value).toBe('12');
    await userEvent.click(within(conditionRow(1, 1)).getByRole('button', { name: 'Done' }));
    await userEvent.click(within(conditionRow(1, 1)).getByRole('button', { name: 'Remove condition: b-count is 12' }));
    expect(within(stepCard(1)).queryByRole('group', { name: 'Step 1 condition 1' })).toBeNull();
  });

  it('writes the three operators in words: is, is one of, is between', async () => {
    await started(['k-1']);
    await addCondition(1, 'b-name');
    fireEvent.change(rowField(1, 1, 'Value'), { target: { value: 'abc' } });
    await userEvent.click(within(conditionRow(1, 1)).getByRole('button', { name: 'Done' }));
    expect(within(conditionRow(1, 1)).getByText('b-name is abc')).toBeTruthy();
    await editRow(1, 1);
    await userEvent.selectOptions(rowField(1, 1, 'Operator'), 'in');
    fireEvent.change(rowField(1, 1, 'Values, separated by commas'), { target: { value: 'a, b' } });
    await userEvent.click(within(conditionRow(1, 1)).getByRole('button', { name: 'Done' }));
    expect(within(conditionRow(1, 1)).getByText('b-name is one of a, b')).toBeTruthy();
    await editRow(1, 1);
    await userEvent.selectOptions(rowField(1, 1, 'Operator'), 'between');
    fireEvent.change(rowField(1, 1, 'From'), { target: { value: 'a' } });
    fireEvent.change(rowField(1, 1, 'To'), { target: { value: 'f' } });
    await userEvent.click(within(conditionRow(1, 1)).getByRole('button', { name: 'Done' }));
    expect(within(conditionRow(1, 1)).getByText('b-name is between a and f')).toBeTruthy();
  });

  it('says in the form what the property holds and which operators it has, and what a value looks like, from the declared kind', async () => {
    await started(['k-1'], withKinds());
    await addCondition(1, 'b-count');
    expect(screen.getByText('b-count is a number. Operators: is, is one of, is between.')).toBeTruthy();
    await userEvent.selectOptions(rowField(1, 1, 'Operator'), 'between');
    expect(screen.getByText('Numbers only. Both ends are included.')).toBeTruthy();
    expect(screen.getByText('Value types: text, number, true / false, date, date-time, time. Date-times and times are in UTC.')).toBeTruthy();
    expect(within(conditionRow(1, 1)).queryByLabelText('Step 1 condition 1: Kind of value')).toBeNull();
  });

  it('reads a value as the declared kind, and refuses what is not one in Expand’s words', async () => {
    const kit = await started(['k-1'], withKinds());
    await addCondition(1, 'b-count');
    fireEvent.change(rowField(1, 1, 'Value'), { target: { value: 'abc' } });
    expect(screen.getByText('Enter a number.')).toBeTruthy();
    fireEvent.change(rowField(1, 1, 'Value'), { target: { value: '7' } });
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(kit.validations[kit.validations.length - 1]?.definition).toMatchObject({ steps: [{ conditions: [{ property: 'b-count', value: { kind: 'number', value: 7 } }] }] });
  });

  it('offers a kind of value only for a property whose kind is not declared', async () => {
    await started(['k-1']);
    await addCondition(1, 'b-name');
    expect(within(conditionRow(1, 1)).getByLabelText('Step 1 condition 1: Kind of value')).toBeTruthy();
    expect(screen.getByText('b-name has no declared kind. Choose how its value is read in Kind of value.')).toBeTruthy();
  });

  it('gives a property that every carrying row declares the kind they agree on, and none a kind they do not', async () => {
    await started(['k-1'], withKinds());
    await addCondition(1, 'q-when');
    expect(within(conditionRow(1, 1)).queryByLabelText('Step 1 condition 1: Kind of value')).toBeNull();
    expect(screen.getByText('q-when is a date and time with a zone. Operators: is, is one of, is between.')).toBeTruthy();
  });

  it('gives a true or false property only “is” and “is one of”', async () => {
    const base = withKinds();
    const profile = { ...base, entityTypes: base.entityTypes.map((entity) => (entity.type === 'c-b' ? { ...entity, filterKinds: { ...entity.filterKinds, 'b-name': 'boolean' } } : entity)) } as SourceProfile;
    await started(['k-1'], profile);
    await addCondition(1, 'b-name');
    expect([...(rowField(1, 1, 'Operator') as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(['is', 'is one of']);
    expect(screen.getByText('b-name is true or false. Operators: is, is one of.')).toBeTruthy();
  });

  it('keeps the form open on Done while the value cannot be read, and says why in words', async () => {
    await started(['k-1']);
    await addCondition(1);
    await userEvent.click(within(conditionRow(1, 1)).getByRole('button', { name: 'Done' }));
    expect(screen.getByText('Enter a value.')).toBeTruthy();
    expect(within(conditionRow(1, 1)).getByRole('button', { name: 'Done' })).toBeTruthy();
    fireEvent.change(rowField(1, 1, 'Value'), { target: { value: 'x'.repeat(257) } });
    expect(screen.getByText('Enter at most 256 characters.')).toBeTruthy();
  });

  it('removes a new row on Cancel, and puts an existing row back as it was', async () => {
    await started(['k-1']);
    await addCondition(1);
    await userEvent.click(within(conditionRow(1, 1)).getByRole('button', { name: 'Cancel' }));
    expect(within(stepCard(1)).queryByRole('group', { name: 'Step 1 condition 1' })).toBeNull();
    await addCondition(1, 'b-name');
    fireEvent.change(rowField(1, 1, 'Value'), { target: { value: 'abc' } });
    await userEvent.click(within(conditionRow(1, 1)).getByRole('button', { name: 'Done' }));
    await editRow(1, 1);
    fireEvent.change(rowField(1, 1, 'Value'), { target: { value: 'changed' } });
    await userEvent.click(within(conditionRow(1, 1)).getByRole('button', { name: 'Cancel' }));
    expect(within(conditionRow(1, 1)).getByText('b-name is abc')).toBeTruthy();
  });

  it('says in the menu and on the tab how many personal-data properties masking hides, and offers none of them', async () => {
    await started(['k-1'], conditionsProfile(), true);
    await openMenu();
    expect(menuItems()).toEqual(['b-name', 'b-count', 'q-size', 'q-when']);
    expect(screen.getByText('1 personal-data property hidden (masking on)')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByText('Personal-data properties are hidden')).toBeTruthy();
  });

  it('says a full group is full, with Remove one to add another, and leaves the other group open', async () => {
    await started(['k-1']);
    for (let count = 0; count < 6; count += 1) {
      await addCondition(1);
      fireEvent.change(rowField(1, count + 1, 'Value'), { target: { value: String(count) } });
      await userEvent.click(within(conditionRow(1, count + 1)).getByRole('button', { name: 'Done' }));
    }
    expect(screen.getByText('Arriving C-B has 6 of 6. Remove one to add another.')).toBeTruthy();
    expect(within(stepCard(1)).getByRole('group', { name: 'Arriving C-B · 6 of 6' })).toBeTruthy();
    await openMenu();
    const blocked = screen.getAllByRole('menuitem').filter((item) => item.getAttribute('aria-disabled') === 'true').map((item) => item.textContent);
    expect(blocked).toEqual(['b-name', 'b-count', 'b-secret']);
  });
});
