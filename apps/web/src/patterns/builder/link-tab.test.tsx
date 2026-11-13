import { afterEach, describe, expect, it } from 'vitest';
import { addStepButton, buildStep, builderProfile, builderWorkspace, chooseDirection, chooseStart, chosenTypes, cleanup, field, openBuilder, screen, stepCard, toggleType, userEvent, within } from './builder-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const optionTexts = (select: HTMLSelectElement): string[] => [...select.options].map((option) => option.textContent ?? '');

async function started(type = 'n-a') {
  await builderWorkspace();
  await openBuilder();
  await chooseStart(type);
}

describe('the Link tab', () => {
  it('has the direction as three choices with the meaning of the one chosen, and the types and the arrival', async () => {
    await started();
    await userEvent.click(addStepButton());
    const step = within(stepCard(1));
    expect(step.getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['Outgoing', 'Incoming', 'Either']);
    expect(step.getAllByRole('radio').every((radio) => radio.getAttribute('aria-checked') === 'false')).toBe(true);
    expect((field(1, 'Arrives at')).disabled).toBe(true);
    await chooseDirection(1, 'out');
    expect(step.getByText('Outgoing: the relationship points from N-A to the next entity.')).toBeTruthy();
    expect(optionTexts(field(1, 'Arrives at'))).toEqual(['Choose a type', 'N-A', 'N-B']);
    await chooseDirection(1, 'in');
    expect(optionTexts(field(1, 'Arrives at'))).toEqual(['Choose a type', 'N-A']);
    expect(step.getByText('Incoming: the relationship points to N-A from the next entity.')).toBeTruthy();
  });

  it('says why a direction that reaches nothing offers nothing', async () => {
    await started('n-c');
    await userEvent.click(addStepButton());
    await chooseDirection(1, 'in');
    expect(optionTexts(field(1, 'Arrives at'))).toEqual(['Choose a type', 'N-B']);
    cleanup();
    document.body.replaceChildren();
    await started('n-d');
    await userEvent.click(addStepButton());
    await chooseDirection(1, 'out');
    expect(optionTexts(field(1, 'Arrives at'))).toEqual(['Choose a type']);
    expect(screen.getByText('No relationship type in the mapping joins N-D in this direction.')).toBeTruthy();
  });

  it('either direction reaches the types of both orientations, each once', async () => {
    await started('n-b');
    await userEvent.click(addStepButton());
    await chooseDirection(1, 'both');
    expect(optionTexts(field(1, 'Arrives at'))).toEqual(['Choose a type', 'N-A', 'N-C']);
  });

  it('lists in the Add type menu what leaves the start, each type once for each type it leads to, with its date, the chosen ones ticked', async () => {
    await started();
    await userEvent.click(addStepButton());
    await chooseDirection(1, 'out');
    await userEvent.click(within(stepCard(1)).getByRole('button', { name: '+ Add type' }));
    const items = screen.getAllByRole('menuitemcheckbox').map((item) => `${item.getAttribute('aria-checked')} ${item.textContent}`);
    expect(items).toEqual(['false r-1→ N-B · no date', 'false r-2→ N-B · no date', 'false r-self→ N-A · no date']);
    expect(screen.getByRole('menu', { name: 'Leaving a N-A, outgoing' })).toBeTruthy();
    expect(screen.getByText('Only types in the mapping are listed.')).toBeTruthy();
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: /^r-1/ }));
    // once the arrival type is chosen the menu lists only the types that lead to it
    expect(screen.getAllByRole('menuitemcheckbox').map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(field(1, 'Arrives at').value).toBe('n-b');
    expect(chosenTypes(1)).toEqual(['r-1']);
  });

  it('shows only the types that lead to the arrival type once it is chosen, and unticks by chip', async () => {
    await started();
    await buildStep(1, 'out', 'n-b', ['r-1', 'r-2']);
    expect(chosenTypes(1)).toEqual(['r-1', 'r-2']);
    expect(within(stepCard(1)).getByText('Relationship types · 2 of 6')).toBeTruthy();
    await userEvent.click(within(stepCard(1)).getByRole('button', { name: 'Remove r-1' }));
    expect(chosenTypes(1)).toEqual(['r-2']);
    await userEvent.click(within(stepCard(1)).getByRole('button', { name: '+ Add type' }));
    expect(screen.getAllByRole('menuitemcheckbox')).toHaveLength(2);
  });

  it('refuses a seventh relationship type: at six the other items are disabled with the reason, and the six stay', async () => {
    await started('n-c');
    await buildStep(1, 'out', 'n-d', ['r-d1', 'r-d2', 'r-d3', 'r-d4', 'r-d5', 'r-d6']);
    expect(within(stepCard(1)).getByText('Relationship types · 6 of 6')).toBeTruthy();
    await userEvent.click(within(stepCard(1)).getByRole('button', { name: '+ Add type' }));
    const seventh = screen.getByRole('menuitemcheckbox', { name: /^r-d7/ });
    expect(seventh.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getAllByText('At most 6 relationship types in a step.').length).toBeGreaterThan(0);
    await userEvent.click(seventh);
    expect(chosenTypes(1)).toHaveLength(6);
  });

  it('opens with the first item focused, moves with the arrows, ticks with Space, and closes on Escape with the focus on the button, leaving the panel open', async () => {
    await started();
    await userEvent.click(addStepButton());
    await chooseDirection(1, 'out');
    const button = within(stepCard(1)).getByRole('button', { name: '+ Add type' });
    await userEvent.click(button);
    const items = screen.getAllByRole('menuitemcheckbox');
    expect(document.activeElement).toBe(items[0]);
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[1]);
    await userEvent.keyboard(' ');
    expect(items[1]?.getAttribute('aria-checked')).toBe('true');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(screen.getByRole('tab', { name: 'Start' })).toBeTruthy();
  });

  it('keeps saying "the next entity" once the arrival type is chosen, as the frame does', async () => {
    await started();
    await buildStep(1, 'out', 'n-b', ['r-1']);
    expect(within(stepCard(1)).getByText('Outgoing: the relationship points from N-A to the next entity.')).toBeTruthy();
  });

  it('says in the menu which types have a date in the mapping and which have none', async () => {
    const base = builderProfile();
    const dated = { ...base, relationshipTypes: base.relationshipTypes.map((row) => (row.type === 'r-1' ? { ...row, observedAt: 'when' } : row)) };
    await builderWorkspace({ profile: async () => ({ ok: true, value: dated }) });
    await openBuilder();
    await chooseStart('n-a');
    await userEvent.click(addStepButton());
    await chooseDirection(1, 'out');
    await userEvent.click(within(stepCard(1)).getByRole('button', { name: '+ Add type' }));
    expect(screen.getAllByRole('menuitemcheckbox').map((item) => item.textContent)).toEqual(['r-1→ N-B · has date', 'r-2→ N-B · no date', 'r-self→ N-A · no date']);
  });
});
