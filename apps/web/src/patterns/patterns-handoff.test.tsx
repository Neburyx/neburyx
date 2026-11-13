import { act, cleanup, screen, within } from '@testing-library/react';
import type { ApiResult } from '../api/client.js';
import type { TemplateListResponse } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { listOf, openBuiltIn, openPatterns, patternsWorkspace, settle } from './patterns-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const formOf = (): string | undefined => screen.queryByRole('button', { name: 'Back to patterns' }) === null ? undefined : screen.getByRole('heading', { level: 2 }).textContent ?? '';

const openFromHome = async (state: Awaited<ReturnType<typeof patternsWorkspace>>['state'], preset: string): Promise<void> => {
  act(() => {
    state.presentation.setPatternsPreset(preset);
    state.presentation.setPatternsOpen(true);
  });
  await settle();
};

describe('the Patterns panel opened with a preset handed over by Home', () => {
  it('opens the form of that preset, and clears the hand-off once the list is shown', async () => {
    const { state } = await patternsWorkspace();
    await openFromHome(state, 'shared-addresses');
    expect(formOf()).toBe('Shared addresses');
    expect(state.presentation.view.getState().patternsPreset).toBeUndefined();
  });

  it('shows the list, with no error, for a preset the list does not hold', async () => {
    const { state } = await patternsWorkspace();
    await openFromHome(state, 'gone');
    expect(formOf()).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Run Shared devices' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not select the handed preset again when the panel is closed and opened from the tool strip', async () => {
    const { state } = await patternsWorkspace();
    await openFromHome(state, 'connected-accounts');
    expect(formOf()).toBe('Connected accounts');
    act(() => state.presentation.setPatternsOpen(false));
    await settle();
    await openPatterns();
    expect(formOf()).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Run Shared devices' })).toBeTruthy();
  });

  it('forgets a preset that was handed over when the panel is closed before its list was shown', async () => {
    let answer: (value: ApiResult<TemplateListResponse>) => void = () => undefined;
    const { state } = await patternsWorkspace({ list: () => new Promise((resolve) => (answer = resolve)) });
    await openFromHome(state, 'connected-accounts');
    act(() => state.presentation.setPatternsOpen(false));
    expect(state.presentation.view.getState().patternsPreset).toBeUndefined();
    answer({ ok: true, value: listOf() });
  });

  it('keeps the handed preset through the loading state and a rebuild of the panel, and opens its form once the list shows', async () => {
    let answer: (value: ApiResult<TemplateListResponse>) => void = () => undefined;
    const { state } = await patternsWorkspace({ list: () => new Promise((resolve) => (answer = resolve)) });
    await openFromHome(state, 'shared-addresses');
    expect(screen.getByText('Loading patterns…')).toBeTruthy();
    expect(state.presentation.view.getState().patternsPreset).toBe('shared-addresses');
    act(() => state.setMask(true));
    await settle();
    expect(state.presentation.view.getState().patternsPreset).toBe('shared-addresses');
    await act(async () => answer({ ok: true, value: listOf() }));
    await settle();
    expect(formOf()).toBe('Shared addresses');
  });
});
