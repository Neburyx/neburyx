import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { filtersWorkspace, openFilters } from './filters-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const panel = (): HTMLElement => screen.getByRole('group', { name: 'Entity types' });
const chip = (name: string): HTMLElement => within(panel()).getByRole('button', { name });

describe('the Filters panel', () => {
  it('opens with one chip for each entity type of the mapping, all on, and the focus on the first', async () => {
    await filtersWorkspace();
    openFilters();
    const chips = within(panel()).getAllByRole('button');
    expect(chips.map((entry) => entry.textContent)).toEqual(['KIND-A', 'KIND-B', 'KIND-C']);
    expect(chips.every((entry) => entry.getAttribute('aria-pressed') === 'true')).toBe(true);
    expect(document.activeElement).toBe(chips[0]);
  });

  it('switches a type off on a click, on Space and on Enter, and on again, and says so in aria-pressed', async () => {
    const { state } = await filtersWorkspace();
    openFilters();
    await userEvent.click(chip('KIND-A'));
    expect(chip('KIND-A').getAttribute('aria-pressed')).toBe('false');
    expect(chip('KIND-B').getAttribute('aria-pressed')).toBe('true');
    expect(state.visibleGraph().nodes.map((entry) => entry.ref.stableId)).toEqual(['n2', 'n3']);
    chip('KIND-B').focus();
    await userEvent.keyboard(' ');
    expect(chip('KIND-B').getAttribute('aria-pressed')).toBe('false');
    chip('KIND-C').focus();
    await userEvent.keyboard('{Enter}');
    expect(state.visibleGraph().nodes).toHaveLength(0);
    await userEvent.click(chip('KIND-A'));
    expect(state.visibleGraph().nodes.map((entry) => entry.ref.stableId)).toEqual(['n0', 'n1']);
  });

  it('closes on Escape and gives the focus back to its button, and on the close button', async () => {
    const { state } = await filtersWorkspace();
    openFilters();
    fireEvent.keyDown(chip('KIND-A'), { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Entity types' })).toBeNull();
    expect(state.presentation.view.getState().filtersOpen).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Filters' }));
    openFilters();
    fireEvent.click(screen.getByRole('button', { name: 'Close Filters' }));
    expect(screen.queryByRole('group', { name: 'Entity types' })).toBeNull();
  });

  it('keeps the filters when the panel is closed and opened again', async () => {
    await filtersWorkspace();
    openFilters();
    await userEvent.click(chip('KIND-B'));
    openFilters();
    openFilters();
    expect(chip('KIND-B').getAttribute('aria-pressed')).toBe('false');
  });

  it('shows the pressed state on the tool button while the panel is open', async () => {
    await filtersWorkspace();
    const button = screen.getByRole('button', { name: 'Filters' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    openFilters();
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('the Filters panel before and without a mapping', () => {
  it('says the types are loading before the profile is read, and offers no chip', async () => {
    await filtersWorkspace(undefined, 'pending');
    openFilters();
    expect(within(panel()).getByRole('status').textContent).toBe('Loading types');
    expect(screen.queryByRole('group', { name: 'Relationship types' })).toBeNull();
    expect(within(panel()).queryAllByRole('button')).toEqual([]);
  });

  it('says so for a mapping with no entity types', async () => {
    await filtersWorkspace([], []);
    openFilters();
    expect(within(panel()).getByText('No entity types in the mapping')).toBeDefined();
  });
});

describe('the relationship types of the Filters panel', () => {
  const types = (): HTMLElement => screen.getByRole('group', { name: 'Relationship types' });

  it('lists one checkbox for each relationship type name, all on, under the count of those selected', async () => {
    await filtersWorkspace();
    openFilters();
    expect(within(types()).getAllByRole('checkbox').map((entry) => [entry.textContent, entry.getAttribute('aria-checked')])).toEqual([['link-a', 'true'], ['link-b', 'true']]);
    expect(within(types()).getByText('All 2 relationship types')).toBeDefined();
  });

  it('uses the singular for one relationship type', async () => {
    await filtersWorkspace();
    openFilters();
    await userEvent.click(within(types()).getByRole('checkbox', { name: 'link-a' }));
    expect(within(types()).getByText('1 relationship type selected')).toBeDefined();
  });

  it('switches a type off, says how many are selected, and is cleared by Reset together with the entity types', async () => {
    const { state } = await filtersWorkspace();
    openFilters();
    await userEvent.click(within(types()).getByRole('checkbox', { name: 'link-a' }));
    expect(within(types()).getByText('1 relationship type selected')).toBeDefined();
    expect(state.presentation.view.getState().typeFilter.offRelationshipTypes.has('link-a')).toBe(true);
    await userEvent.click(chip('KIND-B'));
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(state.presentation.view.getState().typeFilter.offRelationshipTypes.size).toBe(0);
    expect(state.presentation.view.getState().typeFilter.offEntityTypes.size).toBe(0);
    expect(within(types()).getByText('All 2 relationship types')).toBeDefined();
  });
});
