import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PatternValidateResponse } from '@neburyx/contracts';
import type { ApiResult } from '../../api/client.js';
import { settle } from '../patterns-kit.js';
import { addStepButton, addCondition, editRow, openStep, afterDebounce, buildStep, chooseArrival, chooseDirection, chooseStart, cleanup, conditionRow, conditionsWorkspace, fireEvent, openBuilder, optionTexts, rowField, screen, stepCard, toggleType, userEvent, within } from './builder-kit.js';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const NODE_ONLY = ['k-6'];
async function started(types: readonly string[], options: Parameters<typeof conditionsWorkspace>[0] = {}, from = 'c-a', to = 'c-b') {
  const kit = await conditionsWorkspace(options);
  await openBuilder();
  await chooseStart(from);
  await buildStep(1, 'out', to, types);
  return kit;
}
const lastDefinition = (kit: Awaited<ReturnType<typeof conditionsWorkspace>>) => kit.validations[kit.validations.length - 1]?.definition;
const type = async (n: number, m: number, label: string, text: string): Promise<void> => {
  await editRow(n, m);
  fireEvent.change(rowField(n, m, label), { target: { value: text } });
};
const done = async (n: number, m: number): Promise<void> => userEvent.click(within(conditionRow(n, m)).getByRole('button', { name: 'Done' }));
const addDisabledReason = (n: number): string | undefined => {
  const button = within(stepCard(n)).getByRole('button', { name: '+ Add condition' });
  return (button as HTMLButtonElement).disabled ? document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent ?? '' : undefined;
};

describe('one condition on the node', () => {
  it('disables Add condition until the step arrives somewhere, and says why', async () => {
    const kit = await conditionsWorkspace();
    await openBuilder();
    await chooseStart('c-a');
    await userEvent.click(addStepButton());
    await openStep(1, 'Conditions');
    expect(addDisabledReason(1)).toBe('Choose where the step arrives first.');
    expect(kit.validations).toHaveLength(0);
  });

  it('offers exactly the filterable properties of the node type, with masking off, and none of the relationship when the rows declare none', async () => {
    await started(NODE_ONLY);
    await addCondition(1);
    expect(optionTexts(rowField(1, 1, 'Property'))).toEqual(['C-B: b-name', 'C-B: b-count', 'C-B: b-secret']);
    expect(optionTexts(rowField(1, 1, 'Operator'))).toEqual(['is', 'is one of', 'is between']);
  });

  it('sends nothing while a row has no value and says nothing about the empty new row, then sends the typed condition', async () => {
    const kit = await started(NODE_ONLY);
    await afterDebounce();
    const before = kit.validations.length;
    await addCondition(1);
    await afterDebounce();
    expect(kit.validations).toHaveLength(before);
    expect(screen.queryByText('Enter a value.')).toBeNull();
    expect(screen.queryByText(/The mapping can follow this pattern|Not valid|Checking/)).toBeNull();
    await type(1, 1, 'Value', '12');
    await afterDebounce();
    expect(lastDefinition(kit)).toMatchObject({ steps: [{ conditions: [{ on: 'neighbor', property: 'b-name', op: 'eq', value: { kind: 'number', value: 12 } }] }] });
    expect(screen.getByText('The mapping can follow this pattern')).toBeTruthy();
  });

  it('says what is wrong with a value once the person has edited it, and refuses a text over 256 characters', async () => {
    const kit = await started(NODE_ONLY);
    await addCondition(1);
    await type(1, 1, 'Value', ' ');
    expect(screen.getByText('Enter a value.')).toBeTruthy();
    await type(1, 1, 'Value', 'x'.repeat(257));
    expect(screen.getByText('Enter at most 256 characters.')).toBeTruthy();
    await afterDebounce();
    expect(kit.validations.every((sent) => JSON.stringify(sent).includes('"conditions"') === false)).toBe(true);
  });

  it('sends the definition again without a condition that is removed', async () => {
    const kit = await started(NODE_ONLY);
    await addCondition(1);
    await type(1, 1, 'Value', 'x');
    await afterDebounce();
    expect(JSON.stringify(lastDefinition(kit))).toContain('conditions');
    await done(1, 1);
    await userEvent.click(within(conditionRow(1, 1)).getByRole('button', { name: /^Remove condition/ }));
    await afterDebounce();
    expect(JSON.stringify(lastDefinition(kit))).not.toContain('conditions');
  });
});

describe('the other operators and the kinds', () => {
  it('sends a list of values of one kind for “is one of” and refuses more than 20, and values of different kinds', async () => {
    const kit = await started(NODE_ONLY);
    await addCondition(1);
    await userEvent.selectOptions(rowField(1, 1, 'Operator'), 'in');
    await type(1, 1, 'Values, separated by commas', 'a, b');
    await afterDebounce();
    expect(lastDefinition(kit)).toMatchObject({ steps: [{ conditions: [{ op: 'in', values: [{ kind: 'text', value: 'a' }, { kind: 'text', value: 'b' }] }] }] });
    await type(1, 1, 'Values, separated by commas', Array.from({ length: 21 }, (_, i) => `v${i}`).join(','));
    expect(screen.getByText('Enter at most 20 values.')).toBeTruthy();
    await type(1, 1, 'Values, separated by commas', '1, a');
    expect(screen.getByText('The values must all be of one kind. Choose one in the kind list.')).toBeTruthy();
  });

  it('sends a range with the ends given, and refuses an empty range, a range over true or false and ends of two kinds', async () => {
    const kit = await started(NODE_ONLY);
    await addCondition(1);
    await userEvent.selectOptions(rowField(1, 1, 'Operator'), 'between');
    await type(1, 1, 'From', '1');
    expect(screen.queryByText('Enter a start, an end, or both.')).toBeNull();
    await type(1, 1, 'To', '5');
    await afterDebounce();
    expect(lastDefinition(kit)).toMatchObject({ steps: [{ conditions: [{ op: 'between', from: { kind: 'number', value: 1 }, to: { kind: 'number', value: 5 } }] }] });
    await type(1, 1, 'From', '');
    await type(1, 1, 'To', '');
    expect(screen.getByText('Enter a start, an end, or both.')).toBeTruthy();
    await userEvent.selectOptions(rowField(1, 1, 'Kind of value'), 'boolean');
    await type(1, 1, 'From', 'true');
    expect(screen.getByText('A range does not apply to true or false.')).toBeTruthy();
    await userEvent.selectOptions(rowField(1, 1, 'Kind of value'), 'auto');
    await type(1, 1, 'From', '1');
    await type(1, 1, 'To', 'x');
    expect(screen.getByText('The start and the end must be of one kind. Choose one in the kind list.')).toBeTruthy();
  });

  it('offers the nine kinds with Expand’s labels and reads a value as the chosen kind', async () => {
    const kit = await started(NODE_ONLY);
    await addCondition(1);
    expect(optionTexts(rowField(1, 1, 'Kind of value'))).toHaveLength(9);
    expect(optionTexts(rowField(1, 1, 'Kind of value'))).toContain('Date and time (with zone)');
    await userEvent.selectOptions(rowField(1, 1, 'Kind of value'), 'number');
    await type(1, 1, 'Value', 'abc');
    expect(screen.getByText('Enter a number.')).toBeTruthy();
    await type(1, 1, 'Value', '7');
    await afterDebounce();
    expect(lastDefinition(kit)).toMatchObject({ steps: [{ conditions: [{ value: { kind: 'number', value: 7 } }] }] });
  });
});

describe('conditions on the relationship', () => {
  it('lists the node’s properties and then the relationship’s that every chosen type declares, and sends on: relationship', async () => {
    const kit = await started(['k-1']);
    await addCondition(1);
    expect(optionTexts(rowField(1, 1, 'Property'))).toEqual(['C-B: b-name', 'C-B: b-count', 'C-B: b-secret', 'Relationship: q-size', 'Relationship: q-when']);
    await userEvent.selectOptions(rowField(1, 1, 'Property'), 'relationship:q-size');
    await type(1, 1, 'Value', '5');
    await afterDebounce();
    expect(lastDefinition(kit)).toMatchObject({ steps: [{ conditions: [{ on: 'relationship', property: 'q-size' }] }] });
  });

  it('offers only what every chosen relationship type declares', async () => {
    await started(['k-1', 'k-2']);
    await addCondition(1);
    expect(optionTexts(rowField(1, 1, 'Property')).filter((text) => text.startsWith('Relationship'))).toEqual(['Relationship: q-size']);
  });

  it('keeps a row whose property the step no longer offers, marks it and sends nothing until it is changed or removed', async () => {
    const kit = await started(['k-1']);
    await addCondition(1);
    await userEvent.selectOptions(rowField(1, 1, 'Property'), 'relationship:q-size');
    await type(1, 1, 'Value', '5');
    await afterDebounce();
    const sent = kit.validations.length;
    await toggleType(1, 'k-1');
    await toggleType(1, 'k-5');
    await afterDebounce();
    expect(within(conditionRow(1, 1)).getByText('This property is not available for the types now chosen.')).toBeTruthy();
    expect(screen.getByText('Step 1: the condition on q-size is not available on k-5.')).toBeTruthy();
    expect(kit.validations).toHaveLength(sent);
    await editRow(1, 1);
    await userEvent.selectOptions(rowField(1, 1, 'Property'), 'relationship:q-when');
    await afterDebounce();
    expect(kit.validations).toHaveLength(sent + 1);
  });

  it('keeps a step’s conditions when a change leaves the step unfollowed, and marks them', async () => {
    await started(['k-1']);
    await addCondition(1);
    await type(1, 1, 'Value', 'a');
    await userEvent.click(addStepButton());
    await chooseDirection(2, 'out');
    await chooseArrival(2, 'c-c');
    await toggleType(2, 'k-3');
    await chooseDirection(1, 'in');
    expect(screen.getByRole('tab', { name: 'Step 1 !' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Step 2' })).toBeTruthy();
    await openStep(1, 'Conditions');
    expect(within(conditionRow(1, 1)).getByText('b-name is a')).toBeTruthy();
  });
});

describe('caps and personal data', () => {
  it('stops the node at six conditions with the reason, and does not offer the node’s properties in a relationship row', async () => {
    await started(['k-1']);
    for (let count = 0; count < 6; count += 1) await addCondition(1);
    expect(addDisabledReason(1)).toBeUndefined();
    await addCondition(1, 'q-size');
    expect(screen.getByText('Arriving C-B has 6 of 6. Remove one to add another.')).toBeTruthy();
    expect(optionTexts(rowField(1, 7, 'Property'))).toContain('C-B: b-name');
    const disabled = [...(rowField(1, 7, 'Property') as HTMLSelectElement).options].filter((option) => option.disabled).map((option) => option.textContent);
    expect(disabled).toEqual(['C-B: b-name', 'C-B: b-count', 'C-B: b-secret']);
  });

  it('says at six node conditions with nothing else offered that the node is full', async () => {
    await started(NODE_ONLY);
    for (let count = 0; count < 6; count += 1) await addCondition(1);
    expect(addDisabledReason(1)).toBe('At most 6 conditions on the node of a step.');
  });

  it('says nothing can be used when the node and the relationship declare no property', async () => {
    await started(['k-3'], {}, 'c-b', 'c-c');
    await openStep(1, 'Conditions');
    expect(addDisabledReason(1)).toBe('No property of these types can be filtered. The mapping declares which can.');
  });

  it('keeps personal-data properties out while masking is on, with the note, and lists them when it is off', async () => {
    const kit = await conditionsWorkspace();
    act(() => kit.state.setMask(true));
    await settle();
    await openBuilder();
    await chooseStart('c-a');
    await buildStep(1, 'out', 'c-b', ['k-6']);
    await addCondition(1);
    expect(optionTexts(rowField(1, 1, 'Property'))).toEqual(['C-B: b-name', 'C-B: b-count']);
    expect(screen.getByText('Personal-data properties are hidden')).toBeTruthy();
    expect(screen.getByText('1 property is not offered in conditions, and their values are not shown in matches. Turn masking off in the toolbar if your role allows it.')).toBeTruthy();
  });

  it('starts a new builder when masking changes, says so, and keeps no condition on personal data', async () => {
    const kit = await started(NODE_ONLY);
    await addCondition(1);
    await userEvent.selectOptions(rowField(1, 1, 'Property'), 'neighbor:b-secret');
    act(() => kit.state.setMask(true));
    await settle();
    expect(screen.queryByRole('region', { name: 'New pattern' })).toBeNull();
    expect(screen.getByText('Masking changed, so the pattern was started again.')).toBeTruthy();
    await openBuilder();
    expect(screen.queryByText('Masking changed, so the pattern was started again.')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Step 1' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Step 1 condition 1' })).toBeNull();
  });
});

describe('what the server finds wrong with a condition or a window', () => {
  const invalid = (...problems: { path: (string | number)[]; code: string }[]): ApiResult<PatternValidateResponse> => ({ ok: true, value: { status: 'invalid', problems } as PatternValidateResponse });

  it('shows each problem next to its row or its window, and one with no row at its step', async () => {
    await started(['k-1'], {
      validate: async () =>
        invalid(
          { path: ['steps', 0, 'conditions', 0, 'property'], code: 'not-filterable' },
          { path: ['steps', 0, 'conditions', 1, 'values'], code: 'bad-shape' },
          { path: ['steps', 0, 'window', 'days'], code: 'bad-value' },
          { path: ['steps', 0, 'conditions', 7], code: 'too-many' },
        ),
    });
    await addCondition(1);
    await type(1, 1, 'Value', 'a');
    await addCondition(1);
    await type(1, 2, 'Value', 'b');
    await afterDebounce();
    expect(within(conditionRow(1, 1)).getByText('This property cannot be used in a condition.')).toBeTruthy();
    expect(within(conditionRow(1, 2)).getByText('This choice does not fit with the others.')).toBeTruthy();
    const stepLevel = screen.getByText('There are more here than a pattern may have.');
    expect(stepCard(1).contains(stepLevel)).toBe(true);
    expect(conditionRow(1, 1).contains(stepLevel)).toBe(false);
    await openStep(1, 'Window');
    expect(within(stepCard(1).querySelector('.patterns-window') as HTMLElement).getByText('This choice is not allowed.')).toBeTruthy();
  });

  it('says in words each code a condition can come back with, by its own sentence', async () => {
    const sentences: Readonly<Record<string, string>> = {
      'unknown-property': 'This property is not in the mapping.',
      'not-filterable': 'This property cannot be used in a condition.',
      'personal-data-masked': 'This property holds personal data and cannot be used while masking is on.',
      'bad-value': 'This choice is not allowed.',
      'bad-shape': 'This choice does not fit with the others.',
      'wrong-type': 'This part of the pattern is not in the form the mapping expects.',
      missing: 'Something is missing here.',
      'too-many': 'There are more here than a pattern may have.',
    };
    await started(['k-1'], { validate: async () => invalid(...Object.keys(sentences).map((code) => ({ path: ['steps', 0, 'conditions', 0], code }))) });
    await addCondition(1);
    await type(1, 1, 'Value', 'a');
    await afterDebounce();
    for (const sentence of Object.values(sentences)) expect(within(conditionRow(1, 1)).getByText(sentence)).toBeTruthy();
  });

  it('shows the valid line and no problem when the server accepts a definition with a condition and a window', async () => {
    await started(['k-1']);
    await addCondition(1);
    await type(1, 1, 'Value', 'a');
    await openStep(1, 'Window');
    await userEvent.click(within(stepCard(1)).getByRole('radio', { name: 'Last N days' }));
    fireEvent.change(within(stepCard(1)).getByLabelText('Step 1 window: Days'), { target: { value: '30' } });
    await afterDebounce();
    expect(screen.getByText('The mapping can follow this pattern')).toBeTruthy();
    expect(stepCard(1).querySelector('.patterns-error')).toBeNull();
  });

  it('never shows a problem of an older definition at a row that has since gone', async () => {
    let release: (answer: ApiResult<PatternValidateResponse>) => void = () => undefined;
    let call = 0;
    await started(['k-1'], {
      validate: () => (++call === 1 ? new Promise((resolve) => (release = resolve)) : Promise.resolve<ApiResult<PatternValidateResponse>>({ ok: true, value: { status: 'ok' } })),
    });
    await addCondition(1);
    await type(1, 1, 'Value', 'a');
    await afterDebounce();
    await done(1, 1);
    await userEvent.click(within(conditionRow(1, 1)).getByRole('button', { name: /^Remove condition/ }));
    await afterDebounce();
    act(() => release(invalid({ path: ['steps', 0, 'conditions', 0, 'property'], code: 'not-filterable' })));
    await settle();
    expect(screen.queryByText('This property cannot be used in a condition.')).toBeNull();
    expect(screen.getByText('The mapping can follow this pattern')).toBeTruthy();
  });
});

describe('the line about a restart by masking', () => {
  it('is gone once the source changes', async () => {
    const kit = await started(NODE_ONLY);
    await addCondition(1);
    act(() => kit.state.setMask(true));
    await settle();
    expect(screen.getByText('Masking changed, so the pattern was started again.')).toBeTruthy();
    act(() => kit.state.bindSource('b'));
    await settle();
    expect(screen.queryByText('Masking changed, so the pattern was started again.')).toBeNull();
  });
});

describe('masking changing with nothing built', () => {
  it('says nothing when the builder held no draft', async () => {
    const kit = await conditionsWorkspace();
    act(() => kit.state.setMask(true));
    await settle();
    expect(screen.queryByText('Masking changed, so the pattern was started again.')).toBeNull();
  });
});
