import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
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
  it('opens the form of the preset handed over, and clears the hand-off', async () => {
    const kit = await patternsWorkspace();
    act(() => {
      kit.state.presentation.setPatternsPreset('connected-accounts');
      kit.state.presentation.setPatternsOpen(true);
    });
    await settle();
    expect(screen.getByRole('heading', { level: 2, name: 'Connected accounts' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back to patterns' })).toBeTruthy();
    expect(kit.state.presentation.view.getState().patternsPreset).toBeUndefined();
  });
});

describe('the list by keyboard and Escape', () => {
  it('names the search and each Run and menu by the pattern, and has no tab to stop at', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha' })]) } });
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByRole('searchbox', { name: 'Search patterns' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run Alpha' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'More: Alpha' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run Shared devices' })).toBeTruthy();
  });

  it('cancels a saved run on its way with Escape, and closes the panel with the next Escape', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha' })]), runSavedPattern: () => new Promise(() => undefined) } });
    await userEvent.click(screen.getByRole('button', { name: 'Run Alpha' }));
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel run' }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    await settle();
    expect(screen.getByText(/^Run cancelled\./)).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Patterns' })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('complementary', { name: 'Patterns' })).toBeNull();
  });

  it('cancels a preset run on its way with Escape from its form, as before', async () => {
    await savedWorkspace({ run: () => new Promise(() => undefined), patterns: { runSavedPattern: async () => ({ ok: true, value: definitionOk(['acc-2']) }) } });
    await userEvent.click(screen.getByRole('button', { name: 'Run Shared devices' }));
    await settle();
    await userEvent.click(screen.getByRole('button', { name: 'Run pattern' }));
    await settle();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Back to patterns' }), { key: 'Escape' });
    await settle();
    expect(screen.getByText('Cancelled. No new matches shown.')).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Patterns' })).toBeTruthy();
  });
});

describe('the menu of another person’s shared pattern, and the search, by keyboard', () => {
  const THEIRS = (over: Record<string, unknown> = {}) => listed({ id: ID, name: 'Beta', ownedByYou: false, visibility: 'shared', owner: { name: 'Pat' }, ...over });

  it('keeps the owner-only items in the arrow order, named with what they are, doing nothing on Enter, and Escape gives the focus back to the button', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([THEIRS()]) } });
    const opener = screen.getByRole('button', { name: 'More: Beta' });
    await userEvent.click(opener);
    const menu = within(screen.getByRole('menu', { name: 'Beta' }));
    expect(document.activeElement).toBe(menu.getByRole('menuitem', { name: 'Run' }));
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(menu.getByRole('menuitem', { name: 'Change, owner only' }));
    expect(screen.getByRole('group', { name: 'Owned by Pat. Only the owner can:' })).toBeTruthy();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('menu', { name: 'Beta' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('leaves Run out of another person’s menu while the pattern cannot run, and draws a rule before Delete in the person’s own menu', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([THEIRS({ availability: { status: 'unavailable', reasons: [{ code: 'unknown-entity-type', path: ['anchorType'] }] } }), listed({ id: '0192f000-0000-7000-8000-000000000002', name: 'Alpha' })]) } });
    await userEvent.click(screen.getByRole('button', { name: 'More: Beta' }));
    expect(within(screen.getByRole('menu', { name: 'Beta' })).queryByRole('menuitem', { name: 'Run' })).toBeNull();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'More: Alpha' }));
    const own = screen.getByRole('menu', { name: 'Alpha' });
    expect(within(own).getByRole('separator')).toBeTruthy();
    expect(own.querySelector('[role="separator"]')?.nextElementSibling?.textContent).toBe('Delete');
  });

  it('clears the search on Escape first and closes the panel only when the box is empty', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([]) } });
    const box = screen.getByRole('searchbox', { name: 'Search patterns' }) as HTMLInputElement;
    await userEvent.type(box, 'abc');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box.value).toBe('');
    expect(screen.getByRole('complementary', { name: 'Patterns' })).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('complementary', { name: 'Patterns' })).toBeNull();
  });
});

