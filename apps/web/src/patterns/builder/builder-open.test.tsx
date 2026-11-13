import { act, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { failure, listOf, patternsWorkspace, openPatterns, selectAccount, settle } from '../patterns-kit.js';
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
    expect(within(panel).getByText('Compose a pattern from your mapping. There is no query text field.')).toBeTruthy();
    expect(within(panel).getByText('Types come from the mapping. A type that is not mapped cannot be chosen.')).toBeTruthy();
    expect(startSelect().value).toBe('');
    expect([...startSelect().options].map((option) => option.textContent)).toEqual(['Choose a type', 'N-A', 'N-B', 'N-C', 'N-D', 'N-E']);
    expect(panel.querySelectorAll('input[type="text"], input[type="search"], textarea')).toHaveLength(0);
  });

  it('hides the panel’s own intro while the builder is open, and shows it again on Back', async () => {
    await builderWorkspace();
    expect(screen.getByText('Approved ways to explore. No query language needed.')).toBeTruthy();
    await openBuilder();
    expect(screen.queryByText('Approved ways to explore. No query language needed.')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Back to patterns' }));
    expect(screen.getByText('Approved ways to explore. No query language needed.')).toBeTruthy();
  });

  it('closes the panel on Escape from the builder even while a preset run is on its way in the hidden list', async () => {
    const kit = await builderWorkspace({ run: () => new Promise(() => undefined) });
    selectAccount(kit.state, 'acc-1');
    await userEvent.click(screen.getByRole('button', { name: 'Run pattern' }));
    await settle();
    await openBuilder();
    await chooseStart('n-a');
    fireEvent.keyDown(startSelect(), { key: 'Escape' });
    expect(screen.queryByRole('heading', { name: 'Patterns' })).toBeNull();
  });

  it('moves the focus to Starts at, and back to New pattern on Back to patterns', async () => {
    await builderWorkspace();
    await openBuilder();
    expect(document.activeElement).toBe(startSelect());
    await userEvent.click(screen.getByRole('button', { name: 'Back to patterns' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New pattern' }));
  });

  it('is disabled with a loading line while the profile is on its way, and says so with Retry when it failed', async () => {
    await builderWorkspace({ profile: () => new Promise(() => undefined) });
    await openBuilder();
    expect(startSelect().disabled).toBe(true);
    expect(screen.getByText('Loading the mapping…')).toBeTruthy();
    cleanup();
    document.body.replaceChildren();
    let calls = 0;
    await builderWorkspace({ profile: async () => (++calls === 1 ? { ok: false, failure: failure('SOURCE_BUSY') } : { ok: true, value: (await import('./builder-kit.js')).builderProfile() }) });
    await openBuilder();
    expect(screen.getByText('The mapping could not be read.')).toBeTruthy();
    expect(startSelect().options).toHaveLength(1);
    await userEvent.click(within(builderPanel()).getByRole('button', { name: 'Retry' }));
    await act(async () => void (await Promise.resolve()));
    expect(startSelect().options.length).toBeGreaterThan(1);
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
  it('keeps the draft and the list’s form while the panel is open', async () => {
    const kit = await builderWorkspace();
    selectAccount(kit.state, 'acc-1');
    await openBuilder();
    await chooseStart('n-b');
    await userEvent.click(screen.getByRole('button', { name: 'Back to patterns' }));
    expect(screen.getByRole('radio', { name: 'Shared devices' }).getAttribute('aria-checked')).toBe('true');
    await openBuilder();
    expect(startSelect().value).toBe('n-b');
  });

  it('closes the panel on Escape and on the close button, dropping the draft, with the focus on the Patterns tool', async () => {
    await builderWorkspace();
    await openBuilder();
    await chooseStart('n-b');
    fireEvent.keyDown(startSelect(), { key: 'Escape' });
    expect(screen.queryByRole('heading', { name: 'Patterns' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Patterns' }));
    await openPatterns();
    await openBuilder();
    expect(startSelect().value).toBe('');
    await userEvent.click(screen.getByRole('button', { name: 'Close Patterns' }));
    expect(screen.queryByRole('heading', { name: 'Patterns' })).toBeNull();
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
