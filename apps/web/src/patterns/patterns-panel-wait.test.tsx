import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { READ_WAIT_MS } from '../api/read-wait.js';
import { page, withDefinition } from './library/library-kit.js';
import { listed, listOf, okRun, openPatterns, patternsWorkspace, settle } from './patterns-kit.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const wait = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const hang = () => new Promise<never>(() => undefined);
const press = async (element: HTMLElement) => {
  await act(async () => void fireEvent.click(element));
  await wait();
};
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const panel = () => within(screen.getByRole('complementary', { name: 'Patterns' }));
const UNREACHABLE = 'The server could not be reached.';
const ALPHA = listed({ id: '0192f000-0000-7000-8000-000000000001', name: 'Alpha' });
const BETA = listed({ id: '0192f000-0000-7000-8000-000000000002', name: 'Beta' });
const HOLDS = listed({ id: '0192f000-0000-7000-8000-000000000003', name: 'Holds its start', kind: 'preset-run', presetId: 'shared-devices', templateId: 'shared-attribute', templateVersion: 1, params: {} });
const deleted = { ok: true as const, value: { id: ALPHA.id, version: 2, deletedAt: '2026-11-12T10:00:00.000Z', purgeAfter: '2026-12-12T10:00:00.000Z' } };
const remove = async (name: string) => {
  await press(button(`More: ${name}`));
  await press(screen.getByRole('menuitem', { name: 'Delete' }));
  await press(within(screen.getByRole('dialog', { name: /Delete/ })).getByRole('button', { name: 'Delete pattern' }));
};
const opened = async () => {
  await openPatterns();
  await settle();
};
const listReads = (kit: Awaited<ReturnType<typeof patternsWorkspace>>) => kit.patternCalls.filter((call) => call.method === 'listPatterns').length;

describe('the Patterns panel: a read that gets no answer', () => {
  it('ends the first read of the saved patterns at the bound, with Try again, which reads', async () => {
    let reads = 0;
    const kit = await patternsWorkspace({ patterns: { listPatterns: () => (++reads === 1 ? hang() : Promise.resolve(page([ALPHA]))) } });
    await opened();
    await wait(READ_WAIT_MS - 1);
    expect(panel().getByText('Loading saved patterns…')).toBeTruthy();
    expect(panel().queryByRole('alert')).toBeNull();
    await wait(1);
    expect(panel().getByRole('alert').textContent).toContain(UNREACHABLE);
    expect(panel().queryByText('Loading saved patterns…')).toBeNull();
    await press(panel().getByRole('button', { name: 'Try again' }));
    expect(listReads(kit)).toBe(2);
    expect(button('Run Alpha')).toBeTruthy();
    expect(panel().queryByRole('alert')).toBeNull();
  });

  it('ends a reread at the bound, keeps the rows and says so, and the next change reads again', async () => {
    let reads = 0;
    const kit = await patternsWorkspace({ patterns: { listPatterns: () => (++reads === 2 ? hang() : Promise.resolve(page(reads === 1 ? [ALPHA, BETA] : []))), deletePattern: async () => deleted } });
    await opened();
    await remove('Alpha');
    expect(listReads(kit)).toBe(2);
    await wait(READ_WAIT_MS - 1);
    expect(panel().queryByText(UNREACHABLE)).toBeNull();
    await wait(1);
    expect(panel().getByText(UNREACHABLE).getAttribute('role')).toBe('alert');
    expect(button('Run Beta')).toBeTruthy();
    await remove('Beta');
    expect(listReads(kit)).toBe(3);
    expect(panel().queryByText(UNREACHABLE)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run Beta' })).toBeNull();
  });

  it('offers Try again over the kept rows when a reread fails, and it reads the list again', async () => {
    let reads = 0;
    const kit = await patternsWorkspace({ patterns: { listPatterns: () => (++reads === 2 ? hang() : Promise.resolve(page(reads === 1 ? [ALPHA, BETA] : [BETA]))), deletePattern: async () => deleted } });
    await opened();
    await remove('Alpha');
    await wait(READ_WAIT_MS);
    await press(button('Try again to read the saved patterns'));
    expect(listReads(kit)).toBe(3);
    expect(panel().queryByText(UNREACHABLE)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run Alpha' })).toBeNull();
  });

  it('ends a Load more at the bound, frees the button, and a later press reads the page', async () => {
    let more = 0;
    const kit = await patternsWorkspace({ patterns: { listPatterns: (query) => (query.cursor === undefined ? Promise.resolve(page([ALPHA], 'c1')) : ++more === 1 ? hang() : Promise.resolve(page([BETA]))) } });
    await opened();
    await press(button('Load more'));
    await wait(READ_WAIT_MS - 1);
    expect(button('Load more').disabled).toBe(true);
    expect(panel().queryByRole('alert')).toBeNull();
    await wait(1);
    expect(panel().getByRole('alert').textContent).toBe(UNREACHABLE);
    expect(button('Load more').disabled).toBe(false);
    expect(button('Load more').getAttribute('aria-busy')).toBeNull();
    await press(button('Load more'));
    expect(listReads(kit)).toBe(3);
    expect(button('Run Beta')).toBeTruthy();
    expect(panel().queryByRole('alert')).toBeNull();
  });

  it('ends the read of the built-in patterns at the bound, with Try again, and then opens the form Home handed over', async () => {
    let reads = 0;
    const kit = await patternsWorkspace({ list: () => (++reads === 1 ? hang() : Promise.resolve({ ok: true as const, value: listOf() })) });
    act(() => kit.state.presentation.setPatternsPreset('shared-devices'));
    await opened();
    await wait(READ_WAIT_MS - 1);
    expect(panel().getByText('Loading patterns…')).toBeTruthy();
    expect(panel().queryByRole('alert')).toBeNull();
    await wait(1);
    expect(panel().getByRole('alert').textContent).toContain(UNREACHABLE);
    expect(panel().queryByText('Loading patterns…')).toBeNull();
    await press(panel().getByRole('button', { name: 'Try again' }));
    expect(reads).toBe(2);
    expect(panel().getByLabelText('Starting account')).toBeTruthy();
    expect(kit.state.presentation.view.getState().patternsPreset).toBeUndefined();
  });

  it('ends the wait of a saved built-in run handed over while the built-in patterns get no answer, and runs its form after Try again', async () => {
    let reads = 0;
    const kit = await patternsWorkspace({ list: () => (++reads === 1 ? hang() : Promise.resolve({ ok: true as const, value: listOf() })), patterns: { listPatterns: async () => page([HOLDS]), runSavedPattern: async () => ({ ok: true, value: okRun(['acc-2']) }) } });
    act(() => kit.state.presentation.setPatternsSaved({ id: HOLDS.id, action: 'run' }));
    await opened();
    await wait(READ_WAIT_MS - 1);
    expect(panel().getAllByRole('status').map((line) => line.textContent)).toContain('Loading patterns…');
    expect(panel().queryByRole('alert')).toBeNull();
    await wait(1);
    expect(panel().getByRole('alert').textContent).toContain(UNREACHABLE);
    expect(panel().queryAllByText('Loading patterns…')).toHaveLength(0);
    expect(panel().getByRole('button', { name: 'Back to patterns' })).toBeTruthy();
    await press(panel().getByRole('button', { name: 'Try again' }));
    expect(reads).toBe(2);
    expect(panel().queryByRole('alert')).toBeNull();
    expect(panel().getByRole('heading', { name: 'Holds its start', level: 2 })).toBeTruthy();
  });

  it('keeps a built-in definition handed over from the library no longer than the failure with Try again, then opens it', async () => {
    let reads = 0;
    const kit = await patternsWorkspace({ list: () => (++reads === 1 ? hang() : Promise.resolve({ ok: true as const, value: withDefinition() })) });
    act(() => kit.state.presentation.setPatternsBuiltIn({ id: 'fan-out', action: 'copy' }));
    await opened();
    await wait(READ_WAIT_MS - 1);
    expect(panel().queryByRole('alert')).toBeNull();
    await wait(1);
    expect(panel().getByRole('alert').textContent).toContain(UNREACHABLE);
    await press(panel().getByRole('button', { name: 'Try again' }));
    expect(panel().getByLabelText('Starting entity type')).toBeTruthy();
    expect(kit.state.presentation.view.getState().patternsBuiltIn).toBeUndefined();
  });

  it('lets go of a saved pattern handed over when the first read of the list is given up', async () => {
    let reads = 0;
    const kit = await patternsWorkspace({ patterns: { listPatterns: () => (++reads === 1 ? hang() : Promise.resolve(page([ALPHA]))) } });
    act(() => kit.state.presentation.setPatternsSaved({ id: ALPHA.id, action: 'run' }));
    await opened();
    await wait(READ_WAIT_MS - 1);
    expect(kit.state.presentation.view.getState().patternsSaved).toBeDefined();
    await wait(1);
    expect(kit.state.presentation.view.getState().patternsSaved).toBeUndefined();
    expect(panel().getByRole('alert').textContent).toContain(UNREACHABLE);
    await press(panel().getByRole('button', { name: 'Try again' }));
    expect(button('Run Alpha')).toBeTruthy();
    expect(kit.patternCalls.filter((call) => call.method === 'runSavedPattern')).toHaveLength(0);
  });

  it('lets go of a saved pattern handed over when the further page it is looked for on is given up', async () => {
    let more = 0;
    const kit = await patternsWorkspace({ patterns: { listPatterns: (query) => (query.cursor === undefined ? Promise.resolve(page([ALPHA], 'c1')) : ++more === 1 ? hang() : Promise.resolve(page([BETA]))) } });
    act(() => kit.state.presentation.setPatternsSaved({ id: BETA.id, action: 'run' }));
    await opened();
    await wait(READ_WAIT_MS - 1);
    expect(kit.state.presentation.view.getState().patternsSaved).toBeDefined();
    expect(button('Load more').disabled).toBe(true);
    await wait(1);
    expect(kit.state.presentation.view.getState().patternsSaved).toBeUndefined();
    expect(panel().getByRole('alert').textContent).toBe(UNREACHABLE);
    expect(button('Load more').disabled).toBe(false);
    await press(button('Load more'));
    expect(button('Run Beta')).toBeTruthy();
  });
});
