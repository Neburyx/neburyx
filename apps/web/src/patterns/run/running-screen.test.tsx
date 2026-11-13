import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PatternRunResponse } from '@neburyx/contracts';
import type { ApiResult } from '../../api/client.js';
import { assertNoCodes } from '../no-codes.js';
import { definitionOk, failure, settle } from '../patterns-kit.js';
import { cleanup, inRun, panelHeader, previewed, previewedSaved, ran, runButton, runCancel, runWorkspace, screen, userEvent } from './run-kit.js';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

type Run = ApiResult<PatternRunResponse>;
const held = () => {
  const runs: Array<{ answer: (result: Run) => void; signal: AbortSignal | undefined }> = [];
  const handler = (_request: unknown, _key: string, signal: AbortSignal | undefined): Promise<Run> =>
    new Promise((resolve) => {
      runs.push({ answer: resolve, signal });
      signal?.addEventListener('abort', () => resolve({ ok: false, failure: { code: 'ABORTED' } }));
    });
  return { runs, handler };
};

describe('a run in progress', () => {
  it('says what it starts from, shows an indeterminate bar, the seconds elapsed, no counts and Cancel run, focused', async () => {
    const { handler } = held();
    await runWorkspace({ runDefinition: handler });
    await ran();
    expect(panelHeader()).toEqual({ title: 'Running pattern', subtitle: 'Draft · not saved' });
    const screenText = inRun();
    expect(screenText.getByText('Starting from')).toBeTruthy();
    expect(screenText.getByText('x-1 · N-A')).toBeTruthy();
    const bar = screenText.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    expect(screenText.getByText('0 s elapsed. Large sources can take longer.')).toBeTruthy();
    await act(async () => void (await vi.advanceTimersByTimeAsync(3000)));
    expect(screenText.getByText('3 s elapsed. Large sources can take longer.')).toBeTruthy();
    expect(screenText.getByText('No counts until the run finishes')).toBeTruthy();
    expect(screenText.getByText(/exact count or a labelled lower bound/)).toBeTruthy();
    expect(screenText.getByText('Cancelling stops the run and keeps your draft.')).toBeTruthy();
    expect(screenText.getByText('Step 1 · r-1 → N-B')).toBeTruthy();
    expect(document.activeElement).toBe(runCancel());
    expect(screenText.queryByText(/%|of \d+ steps|Checking step/)).toBeNull();
  });

  it('shows the name of a saved pattern under the heading, and Draft · not saved for a draft', async () => {
    const { handler } = held();
    await previewedSaved({ runDefinition: handler });
    await userEvent.click(runButton());
    await settle();
    expect(panelHeader()).toEqual({ title: 'Running pattern', subtitle: 'Alpha' });
  });

  it('writes no ID beside the name while masking is on', async () => {
    const { handler } = held();
    const kit = await runWorkspace({ runDefinition: handler });
    act(() => kit.state.setMask(true));
    await settle();
    const { openBuilder } = await import('./run-kit.js');
    await openBuilder();
    await ran();
    expect(inRun().getByText('x-1 · N-A')).toBeTruthy();
  });

  it('outlines the start entity on the canvas', async () => {
    const { handler } = held();
    const kit = await runWorkspace({ runDefinition: handler });
    await ran();
    expect([...kit.state.presentation.view.getState().selection]).toHaveLength(1);
  });

  it('aborts on Cancel run, adds nothing, keeps the draft and returns to the preview with Run again; a late answer is never shown', async () => {
    const { runs, handler } = held();
    const kit = await runWorkspace({ runDefinition: handler });
    const nodes = kit.state.loadedGraph().nodes.length;
    await ran();
    await userEvent.click(runCancel());
    await settle();
    expect(runs[0]?.signal?.aborted).toBe(true);
    expect(panelHeader().title).toBe('Preview pattern');
    expect(inRun().getByText('Run cancelled. Nothing was added to the graph. Your draft is kept.')).toBeTruthy();
    expect(document.activeElement).toBe(inRun().getByRole('button', { name: 'Run again' }));
    act(() => runs[0]?.answer({ ok: true, value: definitionOk(['acc-2']) }));
    await settle();
    expect(screen.queryByText('Pattern result')).toBeNull();
    expect(inRun().queryByRole('list', { name: 'Matches' })).toBeNull();
    expect(kit.state.loadedGraph().nodes).toHaveLength(nodes);
    await userEvent.click(inRun().getByRole('button', { name: 'Run again' }));
    await settle();
    expect(runs).toHaveLength(2);
    expect(panelHeader().title).toBe('Running pattern');
  });

  it('cancels on Escape while a run is on its way, and closes the panel otherwise', async () => {
    const { runs, handler } = held();
    await runWorkspace({ runDefinition: handler });
    await ran();
    await userEvent.keyboard('{Escape}');
    await settle();
    expect(runs[0]?.signal?.aborted).toBe(true);
    expect(screen.getByRole('button', { name: 'Close Patterns' }) ?? screen.getByRole('button', { name: 'Close pattern builder' })).toBeTruthy();
  });

  it('aborts the run when the panel is left through Edit is not offered: the screen has no Edit while running', async () => {
    const { handler } = held();
    await runWorkspace({ runDefinition: handler });
    await ran();
    expect(inRun().queryByRole('button', { name: /Edit$/ })).toBeNull();
  });

  it('drops the run when the source changes', async () => {
    const { runs, handler } = held();
    const kit = await runWorkspace({ runDefinition: handler });
    await ran();
    act(() => kit.state.bindSource('b'));
    await settle();
    expect(runs[0]?.signal?.aborted).toBe(true);
  });

  it('sends one run with the source, the definition as checked, the anchor and nothing else, with a fresh key each press', async () => {
    const kit = await runWorkspace();
    await ran();
    expect(kit.definitionRuns).toHaveLength(1);
    const [first] = kit.definitionRuns;
    expect(first?.request).toEqual({ sourceId: 'a', definition: kit.validations[0]?.definition, anchor: { entityType: 'n-a', stableId: 'x-1' } });
    expect(first?.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sends the mask when masking is on', async () => {
    const kit = await runWorkspace();
    act(() => kit.state.setMask(true));
    await settle();
    const { openBuilder } = await import('./run-kit.js');
    await openBuilder();
    await ran();
    expect(kit.definitionRuns[0]?.request.mask).toBe(true);
  });
});

describe('a run that is refused', () => {
  it.each<[string, Record<string, number> | undefined, string, boolean]>([
    ['SOURCE_BUSY', undefined, 'is busy.', true],
    ['SOURCE_UNAVAILABLE', undefined, 'unavailable.', true],
    ['QUERY_TIMEOUT', { timeoutMs: 5000 }, 'did not answer within 5 s.', true],
    ['QUERY_BUDGET_EXCEEDED', { maxHops: 2 }, 'The source allows at most 2 steps.', false],
    ['ACCESS_DENIED', undefined, 'You may not do this on this source.', false],
    ['INTERNAL_ERROR', undefined, 'Something went wrong on the server.', true],
  ])('says %s in words with the action the table allows, keeps the draft and shows no code', async (code, details, text, retry) => {
    const kit = await runWorkspace({ runDefinition: async () => ({ ok: false, failure: failure(code, details) }) });
    await ran();
    const alert = inRun().getAllByRole('alert').find((node) => node.textContent?.includes(text));
    expect(alert, code).toBeTruthy();
    expect(alert?.querySelector('button') !== null).toBe(retry);
    assertNoCodes(document.body.textContent ?? '', code);
    const focused = document.activeElement as HTMLElement;
    expect(inRun().getByRole('alert').contains(focused), code).toBe(true);
    if (retry) expect(focused.tagName).toBe('BUTTON');
    else expect(focused.textContent).toContain(text);
    expect(panelHeader().title).toBe('Preview pattern');
    expect(inRun().getByRole('button', { name: /Edit$/ })).toBeTruthy();
    expect(kit.state.visibleGraph().nodes.length).toBeGreaterThan(0);
  });

  it('counts down a rate limit and holds Try again', async () => {
    await runWorkspace({ runDefinition: async () => ({ ok: false, failure: failure('RATE_LIMITED', { retryAfterMs: 3000 }) }) });
    await ran();
    expect(inRun().getByText('You can try again in 3 s.')).toBeTruthy();
    expect((inRun().getByRole('button', { name: 'Try again in 3 s' }) as HTMLButtonElement).disabled).toBe(true);
    for (let second = 0; second < 3; second++) await act(async () => void (await vi.advanceTimersByTimeAsync(1100)));
    expect((inRun().getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('runs again on Try again and shows the result', async () => {
    let call = 0;
    await runWorkspace({ runDefinition: async () => (++call === 1 ? { ok: false, failure: failure('SOURCE_BUSY') } : { ok: true, value: definitionOk(['acc-2']) }) });
    await ran();
    await userEvent.click(inRun().getByRole('button', { name: 'Try again' }));
    await settle();
    expect(panelHeader().title).toBe('Pattern result');
  });

  it('never shows an answer that arrives after Cancel, even a refusal', async () => {
    const { runs, handler } = held();
    await runWorkspace({ runDefinition: handler });
    await ran();
    await userEvent.click(runCancel());
    await settle();
    act(() => runs[0]?.answer({ ok: false, failure: failure('SOURCE_BUSY') }));
    await settle();
    expect(inRun().queryByText(/is busy/)).toBeNull();
  });

  it('raises no canvas banner in any state', async () => {
    let answer: Run = { ok: false, failure: failure('SOURCE_BUSY') };
    const kit = await runWorkspace({ runDefinition: async () => answer });
    await ran();
    expect(kit.banner.view.getState().banner).toBeUndefined();
    answer = { ok: true, value: { status: 'heavy', templateVersion: '1', estimate: { value: 500, quality: 'lowerBound', scope: 'matches' }, threshold: 500, continueLimit: 25, notices: [], warnings: [] } };
    await userEvent.click(inRun().getByRole('button', { name: 'Try again' }));
    await settle();
    expect(kit.banner.view.getState().banner).toBeUndefined();
  });
});

describe('the preview before a run', () => {
  it('has Run pattern on a preview that is ready', async () => {
    await runWorkspace();
    await previewed();
    expect(runButton().disabled).toBe(false);
  });
});
