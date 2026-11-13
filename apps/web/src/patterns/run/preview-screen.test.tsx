import { act, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PatternPreviewResponse } from '@neburyx/contracts';
import type { ApiResult } from '../../api/client.js';
import { typedNode } from '../../workspace/filters-kit.js';
import { PREVIEW, failure, settle } from '../patterns-kit.js';
import { afterDebounce, chooseEntity, cleanup, inRun, previewedSaved, panelHeader, previewed, runButton, runWorkspace, screen, startCombo, startHelp, userEvent, validPattern, within } from './run-kit.js';
import { SEARCH_DEBOUNCE_MS } from '../start-entity.js';
import { searchOf } from '../search-kit.js';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('the preview screen', () => {
  it('opens from Preview with the header of a draft, the mapping line, the pattern in words, the bounds, Save pattern… and the footer', async () => {
    const kit = await runWorkspace();
    await previewed();
    expect(panelHeader()).toEqual({ title: 'Preview pattern', subtitle: 'Draft · not saved' });
    expect(inRun().getByText('The mapping can follow this pattern')).toBeTruthy();
    const words = screen.getByRole('region', { name: 'In plain words' });
    for (const text of ['Starts at an N-A.', 'Follows r-1 outgoing to an N-B.']) expect(within(words).getByText(text)).toBeTruthy();
    const bounds = screen.getByRole('region', { name: 'Bounds' });
    expect(within(bounds).getByText('Up to 50 matches per page.')).toBeTruthy();
    expect(within(bounds).getByText('A count above 500 is shown as “at least 500” and labelled lower bound.')).toBeTruthy();
    expect(within(bounds).getByText('Read-only: nothing in the source is changed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save pattern…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Edit$/ })).toBeTruthy();
    expect(runButton()).toBeTruthy();
    // the editor's own run section is gone, and the preview asked the server once, for the definition as checked
    expect(kit.previews).toHaveLength(1);
    expect(kit.previews[0]).toEqual({ sourceId: 'a', definition: kit.validations[0]?.definition });
  });

  it('takes every number of the bounds from the answer', async () => {
    await runWorkspace({ preview: async () => ({ ok: true, value: { status: 'ok', preview: { ...PREVIEW, bounds: { ...PREVIEW.bounds, pageLimit: { value: 7, text: 'x' }, countCap: { value: 90, text: 'y' } } } } }) });
    await previewed();
    expect(screen.getByText('Up to 7 matches per page.')).toBeTruthy();
    expect(screen.getByText(/A count above 90 is shown as “at least 90”/)).toBeTruthy();
  });

  it('names the saved pattern in the header when it was opened from the list', async () => {
    await previewedSaved();
    expect(panelHeader()).toEqual({ title: 'Preview pattern', subtitle: 'Alpha' });
  });

  it('shows the start field with its helper, prefilled from the opened entity, and runs only once one is chosen', async () => {
    await runWorkspace();
    await previewed();
    expect(startCombo().placeholder).toBe('Search by name or ID');
    expect(startHelp()).toBe('Prefilled from the N-A selected or open on the canvas. Otherwise search by name or ID. You must pick one to run.');
    expect(screen.getByText('Chosen:', { exact: false }).textContent).toContain('x-1');
    expect(runButton().disabled).toBe(false);
  });

  it('keeps Run pattern disabled with its reason while no entity is chosen', async () => {
    await runWorkspace({ opened: null, nodes: [] });
    await previewed();
    expect(runButton().disabled).toBe(true);
    expect(runButton().getAttribute('aria-describedby')).toBe('run-start-reason');
    expect(document.getElementById('run-start-reason')?.textContent).toBe('You must pick one to run.');
    await userEvent.type(startCombo(), 'x');
    await act(async () => void (await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 10)));
    await settle();
  });

  it('lists the loaded entities of the type on focus and chooses one with the pointer', async () => {
    await runWorkspace();
    await previewed();
    await chooseEntity('x-2');
    expect(screen.getByText('Chosen:', { exact: false }).textContent).toContain('x-2');
  });

  it('lists the matches of the typed text with their names, IDs and the count of the page, and chooses with arrows and Enter', async () => {
    const found = [typedNode('s-1', 'n-a'), typedNode('s-2', 'n-a'), typedNode('s-3', 'n-a')];
    const kit = await runWorkspace({ opened: null, nodes: [], search: async () => searchOf(found) as never });
    await previewed();
    await userEvent.type(startCombo(), 'jord');
    await act(async () => void (await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 10)));
    await settle();
    expect(kit.searches).toHaveLength(1);
    expect(kit.searches[0]).toMatchObject({ sourceId: 'a', text: 'jord', entityTypes: ['n-a'] });
    const list = screen.getByRole('listbox', { name: 'N-As matching “jord”' });
    expect(within(list).getAllByRole('option').map((option) => option.textContent)).toEqual(['s-1s-1', 's-2s-2', 's-3s-3']);
    expect(screen.getByText('3 matches on this page of 3 · exact. Type more to narrow.')).toBeTruthy();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(screen.getByText('Chosen:', { exact: false }).textContent).toContain('s-3');
    expect(runButton().disabled).toBe(false);
  });

  it('shows no ID beside a name while masking is on', async () => {
    const kit = await runWorkspace();
    act(() => kit.state.setMask(true));
    await settle();
    const { openBuilder } = await import('./run-kit.js');
    await openBuilder();
    await previewed();
    expect(screen.getByText('Chosen:', { exact: false }).textContent).not.toContain('x-1 ·');
    expect(screen.getByText('Chosen:', { exact: false }).textContent).toBe('Chosen: x-1');
  });

  it('says why a search failed in words and keeps the field and its text', async () => {
    await runWorkspace({ opened: null, nodes: [], search: async () => ({ ok: false, failure: failure('SOURCE_BUSY') }) as never });
    await previewed();
    await userEvent.type(startCombo(), 'jord');
    await act(async () => void (await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 10)));
    await settle();
    expect(within(screen.getByRole('alert')).getByText(/is busy/)).toBeTruthy();
    expect(startCombo().value).toBe('jord');
    expect(startCombo().getAttribute('aria-controls')).toBeNull();
  });

  it('returns to the editor with the same draft and view on Edit', async () => {
    await runWorkspace();
    await validPattern();
    await userEvent.click(screen.getByRole('tab', { name: /^Step 1/ }));
    await userEvent.click(screen.getByRole('button', { name: /^Preview/ }));
    await settle();
    expect(screen.queryByRole('tabpanel')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Edit$/ }));
    await settle();
    expect(panelHeader().title).toBe('New pattern');
    expect(screen.getByRole('tab', { name: /^Step 1/ }).getAttribute('aria-selected')).toBe('true');
    expect(within(screen.getByRole('tabpanel', { name: /^Step 1/ })).getByRole('radio', { name: 'Outgoing' }).getAttribute('aria-checked')).toBe('true');
  });

  it('says why the preview could not be made, for a refusal and for an invalid answer, with Try again, and keeps Run off', async () => {
    let answer: ApiResult<PatternPreviewResponse> = { ok: false, failure: failure('NOT_FOUND') };
    const kit = await runWorkspace({ preview: async () => answer });
    await previewed();
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('The preview could not be made.')).toBeTruthy();
    expect(within(alert).getByText('This was not found. It may have been removed.')).toBeTruthy();
    expect(runButton().disabled).toBe(true);
    answer = { ok: true, value: { status: 'invalid', problems: [{ path: ['steps'], code: 'bad-value' }] } };
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await settle();
    expect(kit.previews).toHaveLength(2);
    expect(within(screen.getByRole('alert')).getByText('This choice is not allowed.')).toBeTruthy();
    expect(runButton().disabled).toBe(true);
  });

  it('shows no raw code of the server on the screen', async () => {
    await runWorkspace({ preview: async () => ({ ok: false, failure: failure('QUERY_BUDGET_EXCEEDED') }) });
    await previewed();
    const { assertNoCodes } = await import('../no-codes.js');
    assertNoCodes(document.body.textContent ?? '', 'the preview screen');
  });

  it('shows only the newest answer of the preview and drops one on its way when the source changes', async () => {
    let signal: AbortSignal | undefined;
    const kit = await runWorkspace({ preview: (_request, aborted) => ((signal = aborted), new Promise(() => undefined)) });
    await previewed();
    expect(screen.getAllByText('Reading the pattern in words…')).toHaveLength(2);
    expect(runButton().disabled).toBe(true);
    expect(document.getElementById('run-start-reason')?.textContent).toBe('Reading the pattern in words…');
    act(() => kit.state.bindSource('b'));
    await settle();
    expect(signal?.aborted).toBe(true);
  });
});

describe('Escape in the start field', () => {
  it('closes the list of entities first, with the panel still open, and the panel only when no list is open', async () => {
    await runWorkspace();
    await previewed();
    await userEvent.click(startCombo());
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(startCombo(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('complementary', { name: 'Patterns' })).toBeTruthy();
    fireEvent.keyDown(startCombo(), { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: 'Patterns' })).toBeNull();
  });
});

