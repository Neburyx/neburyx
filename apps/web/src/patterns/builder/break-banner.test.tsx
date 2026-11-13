import { afterEach, describe, expect, it } from 'vitest';
import { buildStep, builderWorkspace, chooseDirection, chooseStart, cleanup, field, openBuilder, openStep, screen, stepCard, stepTab, userEvent, within } from './builder-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

async function twoSteps() {
  await builderWorkspace();
  await openBuilder();
  await chooseStart('n-a');
  await buildStep(1, 'out', 'n-b', ['r-1']);
  await buildStep(2, 'out', 'n-c', ['r-3']);
}
const banner = () => screen.getByRole('group', { name: 'Changes that break the pattern' });

describe('a change that breaks later parts', () => {
  it('lists each broken part in a sentence, says nothing is removed, and has Undo change, with Preview off and the chain saying so', async () => {
    await twoSteps();
    await openStep(1, 'Link');
    await userEvent.selectOptions(field(1, 'Arrives at'), 'n-a');
    expect(within(banner()).getByText('Changing step 1 leaves 3 problems')).toBeTruthy();
    expect(within(banner()).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Step 1: r-1 does not lead to N-A in the mapping.',
      'Step 2: N-A does not reach N-C in this direction.',
      'Step 2: r-3 does not leave a N-A.',
    ]);
    expect(within(banner()).getByText('Nothing is removed for you. Fix each item, or undo the change.')).toBeTruthy();
    expect(screen.getByText('3 problems. Preview is off until they are fixed.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Preview' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('marks the broken steps and parts with "!" and each part in words next to the control', async () => {
    await twoSteps();
    await openStep(1, 'Link');
    await userEvent.selectOptions(field(1, 'Arrives at'), 'n-a');
    expect(stepTab(1).textContent).toBe('Step 1 !');
    expect(within(stepCard(1)).getByRole('tab', { name: 'Link !' })).toBeTruthy();
    expect(within(stepCard(1)).getByRole('tab', { name: 'Conditions · 0' })).toBeTruthy();
    expect(within(stepCard(1)).getByText('r-1 leads to N-B, not N-A.')).toBeTruthy();
    expect(within(stepCard(1)).getByText('Changed from N-B. Choose types that lead to N-A, or change it back.')).toBeTruthy();
    expect((field(1, 'Arrives at') as HTMLSelectElement).value).toBe('n-a');
  });

  it('goes with Undo change: the draft is exactly as before, and the banner and marks are gone', async () => {
    await twoSteps();
    await openStep(1, 'Link');
    await userEvent.selectOptions(field(1, 'Arrives at'), 'n-a');
    await userEvent.click(within(banner()).getByRole('button', { name: 'Undo change' }));
    expect(screen.queryByRole('group', { name: 'Changes that break the pattern' })).toBeNull();
    expect(stepTab(1).textContent).toBe('Step 1');
    expect((field(1, 'Arrives at') as HTMLSelectElement).value).toBe('n-b');
    expect(screen.getByRole('group', { name: 'Path' }).textContent).toBe('N-A→r-1→N-B→r-3→N-C');
  });

  it('goes by itself when the last problem is fixed', async () => {
    await twoSteps();
    await openStep(1, 'Link');
    await userEvent.selectOptions(field(1, 'Arrives at'), 'n-a');
    await userEvent.selectOptions(field(1, 'Arrives at'), 'n-b');
    expect(screen.queryByRole('group', { name: 'Changes that break the pattern' })).toBeNull();
    expect(screen.queryByText(/problems?\. Preview is off/)).toBeNull();
  });

  it('keeps the later steps when a middle step is removed, and marks them under the same banner and Undo', async () => {
    await twoSteps();
    await openStep(1);
    await userEvent.click(within(stepCard(1)).getByRole('button', { name: 'Remove step 1' }));
    expect(screen.getByText('Changing step 1 leaves 2 problems')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Step 1 !' })).toBeTruthy();
    await userEvent.click(within(banner()).getByRole('button', { name: 'Undo change' }));
    expect(screen.getAllByRole('tab', { name: /^Step \d$/ })).toHaveLength(2);
  });

  it('says a change to the start began at the start, and a direction that reaches nothing in words', async () => {
    await twoSteps();
    await chooseStart('n-c');
    expect(screen.getByText(/^Changing the start leaves \d problems$/)).toBeTruthy();
    await userEvent.click(within(banner()).getByRole('button', { name: 'Undo change' }));
    await chooseDirection(2, 'in');
    expect(within(banner()).getAllByRole('listitem').some((item) => /^Step 2: /.test(item.textContent ?? ''))).toBe(true);
  });
});
