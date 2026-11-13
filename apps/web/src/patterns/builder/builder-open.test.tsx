import { act, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { failure, listOf, listed, patternsWorkspace, openPatterns, selectAccount, settle } from '../patterns-kit.js';
import { builderPanel, builderWorkspace, chooseStart, cleanup, openBuilder, screen, startSelect, userEvent, within } from './builder-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('opening the builder from the Patterns panel', () => {
  it('offers New pattern with the cards, with no presets and with a failed list', async () => {
    await builderWorkspace();
    expect(screen.getByRole('button', { name: 'New pattern' })).toBeTruthy();
    cleanup();
    document.body.replaceChildren();
    await patternsWorkspace({ list: async () => ({ ok: true, value: listOf([]) }) });
    await openPatterns();
    expect(screen.getByRole('button', { name: 'New pattern' })).toBeTruthy();
    cleanup();
    document.body.replaceChildren();
    await patternsWorkspace({ list: async () => ({ ok: false, failure: failure('SOURCE_BUSY') }) });
    await openPatterns();
    expect(screen.getByRole('button', { name: 'New pattern' })).toBeTruthy();
  });

  it('shows the heading, both lines and a Starts at choice of the mapping’s types by display name, none chosen, and no text field', async () => {
    await builderWorkspace();
    await openBuilder();
    const panel = builderPanel();
    // the title is the panel's heading, above the editor
    expect(screen.getByRole('heading', { name: 'New pattern' })).toBeTruthy();
    expect(within(panel).getByText('Every pattern starts from one entity you choose when you run it.')).toBeTruthy();
    expect(within(panel).getByRole('group', { name: 'Entity types in the mapping' })).toBeTruthy();
    expect(startSelect().value).toBe('');
    expect([...startSelect().options].map((option) => option.textContent)).toEqual(['Choose a type', 'N-A', 'N-B', 'N-C', 'N-D', 'N-E']);
    expect(panel.querySelectorAll('input[type="text"], input[type="search"], textarea')).toHaveLength(0);
  });

  it('hides the panel’s own intro while the builder is open, and shows it again on Cancel', async () => {
    await builderWorkspace();
    expect(screen.getByText('Approved ways to explore. No query language needed.')).toBeTruthy();
    await openBuilder();
    expect(screen.queryByText('Approved ways to explore. No query language needed.')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Approved ways to explore. No query language needed.')).toBeTruthy();
  });

  it('closes the panel on Escape from the builder even while a preset run is on its way', async () => {
    const kit = await builderWorkspace({ run: () => new Promise(() => undefined) });
    await userEvent.click(screen.getByRole('button', { name: 'Run Shared devices' }));
    selectAccount(kit.state, 'acc-1');
    await userEvent.click(screen.getByRole('button', { name: 'Run pattern' }));
    await settle();
    await userEvent.click(screen.getByRole('button', { name: 'Back to patterns' }));
    await openBuilder();
    await chooseStart('n-a');
    fireEvent.keyDown(startSelect(), { key: 'Escape' });
    expect(screen.queryByRole('heading', { name: 'Patterns' })).toBeNull();
  });

  it('moves the focus to Starts at, and back to New pattern on Cancel', async () => {
    await builderWorkspace();
    await openBuilder();
    expect(document.activeElement).toBe(startSelect());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New pattern' }));
  });

  it('is disabled with a loading line while the profile is on its way, and says so with Retry when it failed', async () => {
    await builderWorkspace({ profile: () => new Promise(() => undefined) });
    await openBuilder();
    expect(startSelect().disabled).toBe(true);
    expect(screen.getByText('Reading the mapping for this source…')).toBeTruthy();
    expect(screen.getByText('Editing is off until it loads. Built-in patterns stay listed.')).toBeTruthy();
    cleanup();
    document.body.replaceChildren();
    let calls = 0;
    await builderWorkspace({ profile: async () => (++calls === 1 ? { ok: false, failure: failure('SOURCE_BUSY') } : { ok: true, value: (await import('./builder-kit.js')).builderProfile() }) });
    await openBuilder();
    expect(screen.getByText('Could not read the mapping.')).toBeTruthy();
    expect(screen.getByText('Nothing was changed.')).toBeTruthy();
    expect(within(builderPanel()).getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(startSelect().options).toHaveLength(1);
    await userEvent.click(within(builderPanel()).getByRole('button', { name: 'Try again' }));
    await act(async () => void (await Promise.resolve()));
    expect(startSelect().options.length).toBeGreaterThan(1);
  });

  it('asks before Close of an unreadable mapping throws away a draft that a saved pattern opened', async () => {
    const item = listed({ id: '0192f000-0000-7000-8000-000000000001', name: 'Alpha', kind: 'definition', definition: { anchorType: 'n-a', steps: [{ relationshipTypes: ['r-1'], direction: 'out', arrivesAt: 'n-b' }] } });
    await patternsWorkspace({ profile: async () => ({ ok: false, failure: failure('SOURCE_BUSY') }), patterns: { listPatterns: async () => ({ ok: true, value: { items: [item], nextCursor: null } }) } });
    await openPatterns();
    await userEvent.click(screen.getByRole('button', { name: 'More: Alpha' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Change' }));
    await settle();
    expect(screen.getByText('Could not read the mapping.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    const dialog = screen.getByRole('dialog', { name: 'Discard this draft?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByText('Could not read the mapping.')).toBeTruthy();
  });

  it('shows the chosen start type as the first chip of the Path and lets it change', async () => {
    await builderWorkspace();
    await openBuilder();
    await chooseStart('n-a');
    expect(screen.getByRole('group', { name: 'Path' }).textContent).toBe('N-A');
    await chooseStart('n-c');
    expect(screen.getByRole('group', { name: 'Path' }).textContent).toBe('N-C');
  });
});

describe('leaving and coming back', () => {
  it('keeps the list’s form while the editor is open, and throws the draft away on Cancel after asking', async () => {
    const kit = await builderWorkspace();
    selectAccount(kit.state, 'acc-1');
    await openBuilder();
    await chooseStart('n-b');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const dialog = screen.getByRole('dialog', { name: 'Discard this draft?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(startSelect().value).toBe('n-b');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Discard this draft?' })).getByRole('button', { name: 'Discard draft' }));
    expect(screen.getByRole('button', { name: 'Run Shared devices' })).toBeTruthy();
    await openBuilder();
    expect(startSelect().value).toBe('');
  });

  it('asks before closing on Escape and on the close button while a draft would be lost, and closes the panel with the focus on the Patterns tool on Discard draft', async () => {
    await builderWorkspace();
    await openBuilder();
    await chooseStart('n-b');
    fireEvent.keyDown(startSelect(), { key: 'Escape' });
    expect(screen.getByRole('dialog').textContent).toContain('The pattern you have built is not saved.');
    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(startSelect().value).toBe('n-b');
    await userEvent.click(screen.getByRole('button', { name: 'Close pattern builder' }));
    expect(screen.getByRole('dialog').textContent).toContain('The pattern you have built is not saved.');
    await userEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(screen.queryByRole('heading', { name: 'Patterns' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Patterns' }));
    await openPatterns();
    await openBuilder();
    expect(startSelect().value).toBe('');
  });

  it('closes the panel at once on Escape and on the close button while nothing is built', async () => {
    await builderWorkspace();
    await openBuilder();
    fireEvent.keyDown(startSelect(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Patterns' })).toBeNull();
    await openPatterns();
    await openBuilder();
    await userEvent.click(screen.getByRole('button', { name: 'Close pattern builder' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Patterns' })).toBeNull();
  });

  it('names the close button for the list, and for the builder while it is open', async () => {
    await builderWorkspace();
    expect(screen.getByRole('button', { name: 'Close Patterns' })).toBeTruthy();
    await openBuilder();
    expect(screen.getByRole('button', { name: 'Close pattern builder' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close Patterns' })).toBeNull();
  });

  it('is drawn again empty when the source changes', async () => {
    const kit = await builderWorkspace();
    await openBuilder();
    await chooseStart('n-b');
    act(() => kit.state.bindSource('b'));
    await act(async () => void (await Promise.resolve()));
    await openBuilder();
    expect(startSelect().value).toBe('');
  });
});
