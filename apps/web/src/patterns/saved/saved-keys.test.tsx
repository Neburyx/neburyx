import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ListedPattern, PatternListResponse } from '@neburyx/contracts';
import type { ApiResult } from '../../api/client.js';
import { definitionOk, listed, patternsWorkspace, settle } from '../patterns-kit.js';
import { openTab, savedWorkspace } from './saved-list.test.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const ID = '0192f000-0000-7000-8000-000000000001';
const page = (items: readonly ListedPattern[]): ApiResult<PatternListResponse> => ({ ok: true, value: { items: [...items], nextCursor: null } });

describe('the hand-off from Home', () => {
  it('opens the panel on the Built-in tab with the preset handed over chosen, and clears the hand-off', async () => {
    const kit = await patternsWorkspace();
    act(() => {
      kit.state.presentation.setPatternsPreset('connected-accounts');
      kit.state.presentation.setPatternsOpen(true);
    });
    await settle();
    expect(screen.getByRole('tab', { name: /Built-in/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Connected accounts' }).getAttribute('aria-checked')).toBe('true');
    expect(kit.state.presentation.view.getState().patternsPreset).toBeUndefined();
  });
});

describe('the tabs by keyboard and Escape', () => {
  it('gives the tab list its role, names, selected state and one stop in the tab order, and names each Run by its pattern', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha' })]) } });
    expect(screen.getByRole('tablist', { name: 'Patterns' })).toBeTruthy();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((entry) => entry.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);
    await openTab(/My patterns/);
    expect(screen.getByRole('tab', { name: /My patterns/ }).getAttribute('aria-controls')).toBe(screen.getByRole('tabpanel', { name: /My patterns/ }).id);
    expect(screen.getByRole('button', { name: 'Run Alpha' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'More: Alpha' })).toBeTruthy();
  });

  it('cancels a saved run on its way with Escape, and closes the panel with the next Escape', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha' })]), runSavedPattern: () => new Promise(() => undefined) } });
    await openTab(/My patterns/);
    await userEvent.click(screen.getByRole('button', { name: 'Run Alpha' }));
    await settle();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Escape' });
    await settle();
    expect(screen.getByText('Cancelled. No new matches shown.')).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Patterns' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('complementary', { name: 'Patterns' })).toBeNull();
  });

  it('cancels a preset run on its way with Escape from the Built-in tab, as before', async () => {
    await savedWorkspace({ run: () => new Promise(() => undefined), patterns: { runSavedPattern: async () => ({ ok: true, value: definitionOk(['acc-2']) }) } });
    await userEvent.click(screen.getByRole('button', { name: 'Run pattern' }));
    await settle();
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Shared devices' }), { key: 'Escape' });
    await settle();
    expect(screen.getByText('Cancelled. No new matches shown.')).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Patterns' })).toBeTruthy();
  });
});
