import { afterEach, describe, expect, it, vi } from 'vitest';
import { addCondition, addStepButton, afterDebounce, buildStep, builderPanel, builderWorkspace, chooseDirection, conditionsWorkspace, chooseStart, chosenTypes, cleanup, field, openBuilder, openStep, screen, stepCard, stepTab, toggleType, userEvent, within } from './builder-kit.js';

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  document.body.replaceChildren();
});

const path = (): string => screen.getByRole('group', { name: 'Path' }).textContent ?? '';
const chain = (): string => screen.getByText(/^Chain ·/).textContent ?? '';
const optionTexts = (select: HTMLSelectElement): string[] => [...select.options].map((option) => option.textContent ?? '');

async function started(type = 'n-a') {
  await builderWorkspace();
  await openBuilder();
  await chooseStart(type);
}

describe('the chain and the tabs of a new pattern', () => {
  it('opens on Start with the chain saying there are no steps, and + Step', async () => {
    await builderWorkspace();
    await openBuilder();
    expect(chain()).toBe('Chain · no steps yet');
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Start']);
    expect(screen.getByRole('tab', { name: 'Start' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Every pattern starts from one entity you choose when you run it.')).toBeTruthy();
    expect(screen.getByLabelText('Starting entity type')).toBeTruthy();
    expect(addStepButton().disabled).toBe(true);
  });

  it('offers only the entity types of the mapping, none chosen, under the line that says so', async () => {
    await builderWorkspace();
    await openBuilder();
    const select = screen.getByLabelText('Starting entity type') as HTMLSelectElement;
    expect(optionTexts(select)).toEqual(['Choose a type', 'N-A', 'N-B', 'N-C', 'N-D', 'N-E']);
    expect(within(builderPanel()).getByRole('group', { name: 'Entity types in the mapping' })).toBeTruthy();
  });

  it('says to add a step once the start is chosen, then counts steps and conditions and draws the chain', async () => {
    await started();
    expect(chain()).toBe('Chain · no steps yet');
    expect(screen.getByText('Add a step to continue')).toBeTruthy();
    expect(path()).toBe('N-A');
    await buildStep(1, 'out', 'n-b', ['r-1']);
    expect(chain()).toBe('Chain · 1 step · 0 conditions');
    expect(path()).toBe('N-A→r-1→N-B');
    await toggleType(1, 'r-2');
    expect(path()).toBe('N-A→r-1 / r-2→N-B');
    await chooseDirection(1, 'both');
    expect(path()).toBe('N-A↔r-1 / r-2↔N-B');
  });

  it('gives each step of the chain a spoken name with its direction, as the arrows are decoration', async () => {
    await started();
    await buildStep(1, 'out', 'n-b', ['r-1']);
    expect(screen.getByRole('group', { name: 'Outgoing: r-1' })).toBeTruthy();
    await chooseDirection(1, 'both');
    expect(screen.getByRole('group', { name: 'Either direction: r-1' })).toBeTruthy();
  });

  it('selects the new step, shows only its panel with its summary, and keeps every step as a tab', async () => {
    await started();
    await buildStep(1, 'out', 'n-b', ['r-1']);
    await buildStep(2, 'out', 'n-c', ['r-3']);
    expect(screen.getAllByRole('tab', { name: /^(Start|Step \d)$/ }).map((tab) => tab.textContent)).toEqual(['Start', 'Step 1', 'Step 2']);
    expect(stepTab(2).getAttribute('aria-selected')).toBe('true');
    expect(within(stepCard(2)).getByText('r-3 → N-C')).toBeTruthy();
    expect(screen.queryByRole('tabpanel', { name: 'Step 1' })).toBeNull();
    await openStep(1);
    expect(within(stepCard(1)).getByText('r-1 → N-B')).toBeTruthy();
    expect(screen.queryByRole('tabpanel', { name: 'Step 2' })).toBeNull();
  });

  it('moves between the tabs with the arrow keys, Home and End, selecting as it goes, with one tab in the tab order', async () => {
    await started();
    await buildStep(1, 'out', 'n-b', ['r-1']);
    await userEvent.click(screen.getByRole('tab', { name: 'Start' }));
    screen.getByRole('tab', { name: 'Start' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(stepTab(1).getAttribute('aria-selected')).toBe('true');
    expect(stepTab(1).tabIndex).toBe(0);
    expect(screen.getByRole('tab', { name: 'Start' }).tabIndex).toBe(-1);
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Start' }).getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{End}');
    expect(stepTab(1).getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Start' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('changing the start and the steps', () => {
  async function twoSteps() {
    await started();
    await buildStep(1, 'out', 'n-b', ['r-1']);
    await buildStep(2, 'out', 'n-c', ['r-3']);
  }

  it('removes the steps after a change that breaks them and says so once', async () => {
    await twoSteps();
    await openStep(1, 'Link');
    await userEvent.selectOptions(field(1, 'Arrives at'), 'n-a');
    expect(screen.queryByRole('tab', { name: 'Step 2' })).toBeNull();
    expect(screen.getAllByText('Steps after this one were removed because they no longer follow from it.')).toHaveLength(1);
  });

  it('keeps the later steps while they still join', async () => {
    await twoSteps();
    await toggleType(1, 'r-2');
    expect(screen.getByRole('tab', { name: 'Step 2' })).toBeTruthy();
    expect(screen.queryByText(/were removed/)).toBeNull();
  });

  it('applies the rule when the start type changes', async () => {
    await twoSteps();
    await chooseStart('n-c');
    expect(screen.queryByRole('tab', { name: 'Step 2' })).toBeNull();
    expect(screen.getByText(/were removed/)).toBeTruthy();
  });
});

describe('Remove step', () => {
  async function twoSteps() {
    await started();
    await buildStep(1, 'out', 'n-b', ['r-1']);
    await buildStep(2, 'out', 'n-c', ['r-3']);
  }

  it('is on every step, named with the step, and removes a step with no conditions at once', async () => {
    await twoSteps();
    await openStep(1);
    expect(within(stepCard(1)).getByRole('button', { name: 'Remove step 1' })).toBeTruthy();
    await userEvent.click(within(stepCard(1)).getByRole('button', { name: 'Remove step 1' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Step 2' })).toBeNull();
  });

  it('removing the last step leaves the start and + Step', async () => {
    await started();
    await buildStep(1, 'out', 'n-b', ['r-1']);
    await userEvent.click(within(stepCard(1)).getByRole('button', { name: 'Remove step 1' }));
    expect(screen.queryByRole('tab', { name: 'Step 1' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Start' }).getAttribute('aria-selected')).toBe('true');
    expect(addStepButton().disabled).toBe(false);
    expect(path()).toBe('N-A');
  });
});

describe('why + Step is disabled', () => {
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

  it('stops at the source’s limit with the reason, and enables again after a removal', async () => {
    await builderWorkspace({ maxHops: 2 });
    await openBuilder();
    await chooseStart('n-a');
    await buildStep(1, 'out', 'n-b', ['r-1']);
    await buildStep(2, 'out', 'n-c', ['r-3']);
    expect(addStepButton().disabled).toBe(true);
    expect(reason('limit').textContent).toBe('This source allows at most 2 steps.');
    await userEvent.click(within(stepCard(2)).getByRole('button', { name: 'Remove step 2' }));
    expect(addStepButton().disabled).toBe(false);
    expect(document.getElementById('pattern-builder-add-reason')).toBeNull();
  });
});

describe('Remove step with conditions, and Preview', () => {
  it('asks before it removes a step that has conditions, and keeps the step on Cancel', async () => {
    await conditionsWorkspace();
    await openBuilder();
    await chooseStart('c-a');
    await buildStep(1, 'out', 'c-b', ['k-6']);
    await addCondition(1);
    await userEvent.click(within(stepCard(1)).getByRole('button', { name: 'Remove step 1' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove step 1?' });
    expect(within(dialog).getByText('1 condition goes with it.')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('tab', { name: 'Step 1' })).toBeTruthy();
    await userEvent.click(within(stepCard(1)).getByRole('button', { name: 'Remove step 1' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove step' }));
    expect(screen.queryByRole('tab', { name: 'Step 1' })).toBeNull();
  });

  it('keeps Preview off until the source has checked this very pattern, then turns it on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const preview = (): HTMLButtonElement => screen.getByRole('button', { name: 'Preview' }) as HTMLButtonElement;
    await builderWorkspace();
    await openBuilder();
    expect(preview().disabled).toBe(true);
    await chooseStart('n-a');
    await buildStep(1, 'out', 'n-b', ['r-1']);
    expect(preview().disabled).toBe(true);
    await afterDebounce();
    expect(preview().disabled).toBe(false);
    await toggleType(1, 'r-2');
    expect(preview().disabled).toBe(true);
  });
});
