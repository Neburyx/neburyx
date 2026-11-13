import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PatternValidateResponse } from '@neburyx/contracts';
import type { ApiResult } from '../../api/client.js';
import { addCondition, afterDebounce, buildStep, builderPanel, chooseStart, cleanup, conditionRow, conditionsWorkspace, openBuilder, openStep, rowField, screen, stepCard, userEvent, within } from './builder-kit.js';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

type Answer = ApiResult<PatternValidateResponse>;
const nameOf = (element: Element | null): string => (element?.getAttribute('aria-label') ?? element?.textContent ?? '').trim();
const describedBy = (element: HTMLElement): string => (element.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();

async function built(validate?: () => Promise<Answer>) {
  await conditionsWorkspace(validate === undefined ? {} : { validate });
  await openBuilder();
  await chooseStart('c-a');
  await buildStep(1, 'out', 'c-b', ['k-1']);
  await addCondition(1);
  fireEvent.change(rowField(1, 1, 'Value'), { target: { value: 'a' } });
  await userEvent.click(within(conditionRow(1, 1)).getByRole('button', { name: 'Done' }));
  await afterDebounce();
}

describe('the keyboard in the editor', () => {
  it('visits the stops in the order of the frame: the panel’s Close, the step tabs as one stop, + Step, Remove step, the parts as one stop, the condition’s Edit and Remove, Add condition, then Cancel and Preview', async () => {
    await built();
    screen.getByRole('button', { name: 'Close Patterns' }).focus();
    const stops: string[] = [nameOf(document.activeElement)];
    for (let count = 0; count < 30; count += 1) {
      await userEvent.tab();
      stops.push(nameOf(document.activeElement));
      if (stops[stops.length - 1] === 'Preview') break;
    }
    const order = ['Close Patterns', 'Step 1', '+ Step', 'Remove step 1', 'Conditions · 1', 'Edit condition: b-name is a', 'Remove condition: b-name is a', '+ Add condition', 'Cancel', 'Preview'];
    const at = order.map((name) => stops.indexOf(name));
    expect(at.every((place) => place >= 0), stops.join(' | ')).toBe(true);
    expect([...at].sort((left, right) => left - right)).toEqual(at);
    // the inline run is the only thing between Add condition and Cancel, until the run lane replaces it
    expect(stops.slice(at[0], at[3] + 1)).toEqual(['Close Patterns', 'Step 1', '+ Step', 'Remove step 1']);
  });

  it('reads a step tab with where it is and whether it is valid, and a part tab with its conditions or problems', async () => {
    await built();
    expect(describedBy(screen.getByRole('tab', { name: 'Step 1' }))).toBe('Step 1 of 1, k-1 to C-B, valid');
    expect(describedBy(within(stepCard(1)).getByRole('tab', { name: 'Conditions · 1' }))).toBe('Conditions, 1 condition');
    expect(describedBy(within(stepCard(1)).getByRole('tab', { name: 'Link' }))).toBe('Link');
  });

  it('reads a step with a problem as having one, and a part with the count of its problems', async () => {
    await built(async () => ({ ok: true, value: { status: 'invalid', problems: [{ path: ['steps', 0, 'conditions', 0, 'property'], code: 'not-filterable' }] } as PatternValidateResponse }));
    const tab = screen.getByRole('tab', { name: 'Step 1 !' });
    expect(describedBy(tab)).toBe('Step 1 of 1, k-1 to C-B, has a problem');
    expect(describedBy(within(stepCard(1)).getByRole('tab', { name: 'Conditions · 1 !' }))).toBe('Conditions, 1 problem');
  });

  it('says why Preview is off after its name, and links the sentence about a row to the row', async () => {
    await built(async () => ({ ok: true, value: { status: 'invalid', problems: [{ path: ['steps', 0, 'conditions', 0, 'property'], code: 'not-filterable' }, { path: ['steps'], code: 'too-many' }] } as PatternValidateResponse }));
    const preview = screen.getByRole('button', { name: 'Preview' });
    expect(describedBy(preview)).toBe('unavailable, 2 problems from the source');
    await openStep(1, 'Conditions');
    const row = conditionRow(1, 1);
    expect(describedBy(row)).toBe('This property cannot be used in a condition.');
    expect(builderPanel().contains(row)).toBe(true);
  });

  it('moves in the Add condition menu with the arrow keys and gives the focus back to the button on Escape, leaving the panel open', async () => {
    await built();
    await openStep(1, 'Conditions');
    const button = within(stepCard(1)).getByRole('button', { name: '+ Add condition' });
    button.focus();
    await userEvent.keyboard('{Enter}');
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[1]);
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(document.activeElement).toBe(items[items.length - 1]);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(builderPanel()).toBeTruthy();
  });
});
