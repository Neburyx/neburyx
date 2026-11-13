import { afterEach, describe, expect, it } from 'vitest';
import { addStepButton, buildStep, builderWorkspace, chooseStart, cleanup, field, openBuilder, screen, stepCard, userEvent, within } from './builder-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const path = (): string => screen.getByRole('group', { name: 'Path' }).textContent ?? '';
const optionTexts = (select: HTMLSelectElement): string[] => [...select.options].map((option) => option.textContent ?? '');
const checkboxes = (n: number): string[] => within(stepCard(n)).queryAllByRole('checkbox').map((box) => box.parentElement?.textContent ?? '');

async function started(type = 'n-a') {
  await builderWorkspace();
  await openBuilder();
  await chooseStart(type);
}

describe('adding a step', () => {
  it('adds a step with the three choices, none made, and offers only what the mapping reaches', async () => {
    await started();
    await userEvent.click(addStepButton());
    expect(optionTexts(field(1, 'Direction'))).toEqual(['Choose a direction', 'Outgoing', 'Incoming', 'Either direction']);
    expect(field(1, 'Arrives at').disabled).toBe(true);
    await userEvent.selectOptions(field(1, 'Direction'), 'out');
    expect(optionTexts(field(1, 'Arrives at'))).toEqual(['Choose a type', 'N-A', 'N-B']);
    await userEvent.selectOptions(field(1, 'Direction'), 'in');
    expect(optionTexts(field(1, 'Arrives at'))).toEqual(['Choose a type', 'N-A']);
  });

  it('lists the relationship types that join the two types, once each however many rows, as checkboxes', async () => {
    await started();
    await userEvent.click(addStepButton());
    await userEvent.selectOptions(field(1, 'Direction'), 'out');
    await userEvent.selectOptions(field(1, 'Arrives at'), 'n-b');
    expect(checkboxes(1)).toEqual(['r-1', 'r-2']);
  });

  it('says why a direction that reaches nothing offers nothing', async () => {
    await started('n-c');
    await userEvent.click(addStepButton());
    await userEvent.selectOptions(field(1, 'Direction'), 'in');
    expect(optionTexts(field(1, 'Arrives at'))).toEqual(['Choose a type', 'N-B']);
    cleanup();
    document.body.replaceChildren();
    await started('n-d');
    await userEvent.click(addStepButton());
    await userEvent.selectOptions(field(1, 'Direction'), 'out');
    expect(optionTexts(field(1, 'Arrives at'))).toEqual(['Choose a type']);
    expect(screen.getByText('No relationship type in the mapping joins N-D in this direction.')).toBeTruthy();
  });

  it('draws the Path with one type, with several joined by “or”, and with each arrow', async () => {
    await started();
    await buildStep(1, 'out', 'n-b', ['r-1']);
    expect(path()).toBe('N-A→r-1→N-B');
    await userEvent.click(within(stepCard(1)).getByRole('checkbox', { name: 'r-2' }));
    expect(path()).toBe('N-A→r-1 or r-2→N-B');
    await userEvent.selectOptions(field(1, 'Direction'), 'both');
    expect(path()).toBe('N-A↔r-1 or r-2↔N-B');
    await userEvent.selectOptions(field(1, 'Direction'), 'in');
    expect(path()).toBe('N-A');
  });

  it('offers a second step from the arrival type of the first, and draws both', async () => {
    await started();
    await buildStep(1, 'out', 'n-b', ['r-1']);
    await userEvent.click(addStepButton());
    await userEvent.selectOptions(field(2, 'Direction'), 'out');
    expect(optionTexts(field(2, 'Arrives at'))).toEqual(['Choose a type', 'N-C']);
    await userEvent.selectOptions(field(2, 'Arrives at'), 'n-c');
    await userEvent.click(within(stepCard(2)).getByRole('checkbox', { name: 'r-3' }));
    expect(path()).toBe('N-A→r-1→N-B→r-3→N-C');
  });

  it('either direction reaches the types of both orientations, each once', async () => {
    await started('n-b');
    await userEvent.click(addStepButton());
    await userEvent.selectOptions(field(1, 'Direction'), 'both');
    expect(optionTexts(field(1, 'Arrives at'))).toEqual(['Choose a type', 'N-A', 'N-C']);
  });

  it('refuses a seventh relationship type with the reason and keeps the six checked', async () => {
    await started('n-c');
    await buildStep(1, 'out', 'n-d', ['r-d1', 'r-d2', 'r-d3', 'r-d4', 'r-d5', 'r-d6']);
    await userEvent.click(within(stepCard(1)).getByRole('checkbox', { name: 'r-d7' }));
    expect(screen.getByText('At most 6 relationship types in a step.')).toBeTruthy();
    expect(within(stepCard(1)).getAllByRole('checkbox').filter((box) => (box as HTMLInputElement).checked)).toHaveLength(6);
    expect((within(stepCard(1)).getByRole('checkbox', { name: 'r-d7' }) as HTMLInputElement).checked).toBe(false);
  });
});

describe('changing and removing steps', () => {
  async function twoSteps() {
    await started();
    await buildStep(1, 'out', 'n-b', ['r-1']);
    await buildStep(2, 'out', 'n-c', ['r-3']);
  }

  it('removes the steps after a change that breaks them and says so once', async () => {
    await twoSteps();
    await userEvent.selectOptions(field(1, 'Arrives at'), 'n-a');
    expect(screen.queryByRole('group', { name: 'Step 2' })).toBeNull();
    expect(screen.getAllByText('Steps after this one were removed because they no longer follow from it.')).toHaveLength(1);
  });

  it('keeps the later steps while they still join', async () => {
    await twoSteps();
    await userEvent.click(within(stepCard(1)).getByRole('checkbox', { name: 'r-2' }));
    expect(screen.getByRole('group', { name: 'Step 2' })).toBeTruthy();
    expect(screen.queryByText(/were removed/)).toBeNull();
  });

  it('applies the rule when the start type changes', async () => {
    await twoSteps();
    await userEvent.selectOptions(screen.getByLabelText('Starts at'), 'n-c');
    expect(screen.queryByRole('group', { name: 'Step 2' })).toBeNull();
    expect(screen.getByText(/were removed/)).toBeTruthy();
  });

  it('has Remove step on the last step only, and removing the only step leaves the start and Add step', async () => {
    await twoSteps();
    expect(within(stepCard(1)).queryByRole('button', { name: 'Remove step' })).toBeNull();
    await userEvent.click(within(stepCard(2)).getByRole('button', { name: 'Remove step' }));
    expect(screen.queryByRole('group', { name: 'Step 2' })).toBeNull();
    await userEvent.click(within(stepCard(1)).getByRole('button', { name: 'Remove step' }));
    expect(screen.queryByRole('group', { name: 'Step 1' })).toBeNull();
    expect(addStepButton().disabled).toBe(false);
    expect(path()).toBe('N-A');
  });
});

describe('why Add step is disabled', () => {
  const reason = (id: string) => document.getElementById('pattern-builder-add-reason') ?? (() => { throw new Error(`no reason for ${id}`); })();

  it('says to choose where the pattern starts, then to complete the last step, then names a type joined to nothing', async () => {
    await builderWorkspace();
    await openBuilder();
    expect(addStepButton().disabled).toBe(true);
    expect(reason('start').textContent).toBe('Choose where the pattern starts first.');
    expect(addStepButton().getAttribute('aria-describedby')).toBe('pattern-builder-add-reason');
    await chooseStart('n-e');
    expect(reason('dead end').textContent).toBe('No relationship type in the mapping joins N-E.');
    await chooseStart('n-a');
    await userEvent.click(addStepButton());
    expect(addStepButton().disabled).toBe(true);
    expect(reason('incomplete').textContent).toBe('Complete the last step first.');
  });

  it('stops at the source’s limit with the reason, shows the Steps line, and enables again after a removal', async () => {
    await builderWorkspace({ maxHops: 2 });
    await openBuilder();
    await chooseStart('n-a');
    expect(screen.getByText('Steps 0 (source limit 2)')).toBeTruthy();
    await buildStep(1, 'out', 'n-b', ['r-1']);
    await buildStep(2, 'out', 'n-c', ['r-3']);
    expect(screen.getByText('Steps 2 (source limit 2)')).toBeTruthy();
    expect(addStepButton().disabled).toBe(true);
    expect(reason('limit').textContent).toBe('This source allows at most 2 steps.');
    await userEvent.click(within(stepCard(2)).getByRole('button', { name: 'Remove step' }));
    expect(addStepButton().disabled).toBe(false);
    expect(document.getElementById('pattern-builder-add-reason')).toBeNull();
  });

  it('uses the contract’s step limit when the source states none', async () => {
    await builderWorkspace();
    await openBuilder();
    await chooseStart('n-a');
    expect(screen.getByText('Steps 0 (source limit 4)')).toBeTruthy();
  });
});
