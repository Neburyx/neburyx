import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addStepButton, afterDebounce, buildStep, chooseArrival, chooseDirection, chooseStart, cleanup, conditionsWorkspace, openBuilder, openStep, screen, stepCard, toggleType, userEvent, within } from './builder-kit.js';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

async function started(types: readonly string[], from = 'c-a', to = 'c-b') {
  const kit = await conditionsWorkspace();
  await openBuilder();
  await chooseStart(from);
  await buildStep(1, 'out', to, types);
  await openStep(1, 'Window');
  return kit;
}
const lastDefinition = (kit: Awaited<ReturnType<typeof conditionsWorkspace>>) => kit.validations[kit.validations.length - 1]?.definition;
const choice = (name: string): HTMLElement => within(stepCard(1)).getByRole('radio', { name });
const dayField = (): HTMLElement => within(stepCard(1)).getByLabelText('Step 1 window: Days');
const dateFields = (): { from: HTMLElement; to: HTMLElement } => ({ from: within(stepCard(1)).getByLabelText('Step 1 window: From (UTC date)'), to: within(stepCard(1)).getByLabelText('Step 1 window: To (UTC date)') });

describe('the Window tab', () => {
  it('offers None, Last N days and Between under the date window of the relationship, with None chosen, and sends no window', async () => {
    const kit = await started(['k-1']);
    expect(within(stepCard(1)).getByRole('group', { name: 'Date window on the relationship' })).toBeTruthy();
    expect(within(stepCard(1)).getAllByRole('radio').map((radio) => `${radio.textContent}:${radio.getAttribute('aria-checked')}`)).toEqual(['None:true', 'Last N days:false', 'Between:false']);
    expect(within(stepCard(1)).getByRole('tab', { name: 'Window · none' })).toBeTruthy();
    await afterDebounce();
    expect(JSON.stringify(lastDefinition(kit))).not.toContain('window');
  });

  it('shows the days in the tab label and the line about the count, and sends days from 1 to 3650, refusing anything else in words', async () => {
    const kit = await started(['k-1']);
    await userEvent.click(choice('Last N days'));
    expect(screen.getByText('Counted back from the day you run it, in UTC.')).toBeTruthy();
    expect(screen.getByText('Enter a whole number of days from 1 to 3650.')).toBeTruthy();
    for (const bad of ['0', '3651', '2.5', 'x']) {
      fireEvent.change(dayField(), { target: { value: bad } });
      expect(screen.getByText('Enter a whole number of days from 1 to 3650.')).toBeTruthy();
    }
    fireEvent.change(dayField(), { target: { value: '30' } });
    expect(within(stepCard(1)).getByRole('tab', { name: 'Window · 30 d' })).toBeTruthy();
    await afterDebounce();
    expect(lastDefinition(kit)).toMatchObject({ steps: [{ window: { days: 30 } }] });
  });

  it('sends two inclusive dates, and says at the field what is wrong: a date that is not one, an end before the start, a range over 3,650 days', async () => {
    const kit = await started(['k-1']);
    await userEvent.click(choice('Between'));
    const set = (from: string, to: string): void => {
      fireEvent.change(dateFields().from, { target: { value: from } });
      fireEvent.change(dateFields().to, { target: { value: to } });
    };
    set('2026-02-30', '2026-03-31');
    expect(screen.getByText('Enter a calendar date like 2026-03-01.')).toBeTruthy();
    expect(dateFields().from.getAttribute('aria-invalid')).toBe('true');
    set('2026-03-01', '2026-02-30');
    expect(dateFields().to.getAttribute('aria-invalid')).toBe('true');
    set('2026-11-01', '2026-10-01');
    expect(screen.getByText('Before the start date')).toBeTruthy();
    expect(dateFields().to.getAttribute('aria-invalid')).toBe('true');
    set('2010-01-01', '2026-01-01');
    expect(screen.getByText('At most 3,650 days, both dates included.')).toBeTruthy();
    set('2016-01-01', '2025-12-29');
    expect(screen.getByText('At most 3,650 days, both dates included.')).toBeTruthy();
    await afterDebounce();
    expect(kit.validations.every((sent) => !JSON.stringify(sent).includes('window'))).toBe(true);
    set('2016-01-01', '2025-12-28');
    expect(screen.queryByRole('alert')).toBeNull();
    set('2026-03-01', '2026-03-31');
    expect(screen.queryByRole('alert')).toBeNull();
    await afterDebounce();
    expect(lastDefinition(kit)).toMatchObject({ steps: [{ window: { from: '2026-03-01', to: '2026-03-31' } }] });
  });

  it('lists each chosen type under "Which types the window can filter": filtered on its date property, or no date in the mapping and why it cannot be filtered', async () => {
    await started(['k-1', 'k-2']);
    const panel = within(within(stepCard(1)).getByRole('group', { name: 'Which types the window can filter' }));
    expect(panel.getByText('k-1').parentElement?.textContent).toBe('k-1 filtered on q-when');
    expect(panel.getByText('k-2').parentElement?.textContent).toBe('k-2 no date in the mapping');
    expect(panel.getByText('It cannot be filtered: k-2 is matched without a date limit.')).toBeTruthy();
    expect(panel.queryByText('It cannot be filtered: k-1 is matched without a date limit.')).toBeNull();
  });

  it('says of a type with a dated and an undated row that it is filtered on one and that the other has no date', async () => {
    const kit = await conditionsWorkspace();
    void kit;
    await openBuilder();
    await chooseStart('c-c');
    await userEvent.click(addStepButton());
    await chooseDirection(1, 'both');
    await chooseArrival(1, 'c-d');
    await toggleType(1, 'k-two');
    await openStep(1, 'Window');
    const panel = within(within(stepCard(1)).getByRole('group', { name: 'Which types the window can filter' }));
    expect(panel.getByText('k-two').parentElement?.textContent).toBe('k-two filtered on q-when; a row of it has no date in the mapping');
    expect(panel.getByText('It cannot be filtered: k-two is matched without a date limit.')).toBeTruthy();
  });

  it('disables the choices with the reason when no chosen type has a date, and takes a window off when a change leaves none, saying so', async () => {
    const kit = await started(['k-1']);
    await userEvent.click(choice('Last N days'));
    fireEvent.change(dayField(), { target: { value: '30' } });
    await toggleType(1, 'k-1');
    await toggleType(1, 'k-2');
    await openStep(1, 'Window');
    expect(within(stepCard(1)).getAllByRole('radio').every((radio) => (radio as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getByText('The window does not apply: no chosen relationship type has an observed time in the mapping.')).toBeTruthy();
    expect(screen.getByText('The window was taken off because no chosen relationship type has an observed time.')).toBeTruthy();
    await afterDebounce();
    expect(JSON.stringify(lastDefinition(kit))).not.toContain('window');
  });

  it('asks for the relationship types first while none is chosen', async () => {
    await conditionsWorkspace();
    await openBuilder();
    await chooseStart('c-a');
    await userEvent.click(addStepButton());
    await openStep(1, 'Window');
    expect(screen.getByText('Choose the relationship types first.')).toBeTruthy();
    expect(within(stepCard(1)).getAllByRole('radio').every((radio) => (radio as HTMLButtonElement).disabled)).toBe(true);
  });
});
