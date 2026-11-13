import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PatternValidateResponse } from '@neburyx/contracts';
import type { ApiResult } from '../../api/client.js';
import { addCondition, afterDebounce, buildStep, chooseStart, cleanup, conditionRow, conditionsWorkspace, editRow, openBuilder, openStep, rowField, screen, startSelect, stepCard, userEvent, within } from './builder-kit.js';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-11-13T09:44:20Z') }));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

type Answer = ApiResult<PatternValidateResponse>;
const invalid = (...problems: { path: (string | number)[]; code: string }[]): Answer => ({ ok: true, value: { status: 'invalid', problems } as PatternValidateResponse });
const panel = () => screen.getByRole('group', { name: 'The mapping cannot follow this pattern yet' });
const preview = () => screen.getByRole('button', { name: 'Preview' }) as HTMLButtonElement;

async function started(validate: () => Promise<Answer>) {
  const kit = await conditionsWorkspace({ validate });
  await openBuilder();
  await chooseStart('c-a');
  await buildStep(1, 'out', 'c-b', ['k-1']);
  await addCondition(1);
  fireEvent.change(rowField(1, 1, 'Value'), { target: { value: 'a' } });
  await userEvent.click(within(conditionRow(1, 1)).getByRole('button', { name: 'Done' }));
  await afterDebounce();
  return kit;
}

describe('the problems the source finds', () => {
  const found = () => invalid({ path: ['steps', 0, 'conditions', 0, 'property'], code: 'not-filterable' }, { path: ['anchorType'], code: 'unknown-entity-type' }, { path: ['steps'], code: 'too-many' });

  it('lists each with its step and part and Show, counts them in the chain, keeps Preview off and says when the source checked', async () => {
    await started(async () => found());
    const list = within(panel());
    expect(list.getAllByRole('listitem').map((item) => item.firstElementChild?.textContent)).toEqual([
      'Step 1 · Conditions: This property cannot be used in a condition.',
      'Start: This type is not in the mapping.',
      'There are more here than a pattern may have.',
    ]);
    expect(list.getAllByRole('button', { name: /^Show problem/ })).toHaveLength(2);
    expect(screen.getByText('3 problems from the source. Preview is off.')).toBeTruthy();
    expect(preview().disabled).toBe(true);
    expect(screen.getByText('Checked by the source at 09:44 UTC.')).toBeTruthy();
  });

  it('announces the count of the problems in a live region when they appear', async () => {
    await started(async () => found());
    const announced = screen.getAllByRole('status').find((region) => region.textContent?.includes('3 problems from the source. Preview is off.'));
    expect(announced).toBeTruthy();
  });

  it('Show opens the part and puts the focus on the row, or on the start type', async () => {
    await started(async () => found());
    await openStep(1, 'Link');
    await userEvent.click(within(panel()).getByRole('button', { name: 'Show problem 1' }));
    expect(within(stepCard(1)).getByRole('tab', { name: /^Conditions/ }).getAttribute('aria-selected')).toBe('true');
    expect(conditionRow(1, 1).contains(document.activeElement)).toBe(true);
    await userEvent.click(within(panel()).getByRole('button', { name: 'Show problem 2' }));
    expect(screen.getByRole('tab', { name: 'Start' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(startSelect());
  });

  it('shows the sentence at its row too, and the panel goes with Preview on once the source accepts', async () => {
    let answer: Answer = found();
    await started(async () => answer);
    await openStep(1, 'Conditions');
    expect(within(conditionRow(1, 1)).getByText('This property cannot be used in a condition.')).toBeTruthy();
    answer = { ok: true, value: { status: 'ok' } };
    await editRow(1, 1);
    fireEvent.change(rowField(1, 1, 'Value'), { target: { value: 'b' } });
    await userEvent.click(within(conditionRow(1, 1)).getByRole('button', { name: 'Done' }));
    await afterDebounce();
    expect(screen.queryByRole('group', { name: 'The mapping cannot follow this pattern yet' })).toBeNull();
    expect(screen.getByText('The mapping can follow this pattern')).toBeTruthy();
    expect(preview().disabled).toBe(false);
  });
});
