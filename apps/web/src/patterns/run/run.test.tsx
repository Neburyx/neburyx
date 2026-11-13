import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PatternPreviewResponse, PatternRunResponse } from '@neburyx/contracts';
import type { ApiResult } from '../../api/client.js';
import { definitionHeavy, definitionOk, failure, settle } from '../patterns-kit.js';
import { afterDebounce, builderPanel, chooseStart, cleanup, runButton, runReason, runWorkspace, screen, userEvent, validPattern, within } from './run-kit.js';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

type Run = ApiResult<PatternRunResponse>;
const pickStart = async (title: string): Promise<void> => {
  const select = screen.getByLabelText('Starts from') as HTMLSelectElement;
  await userEvent.selectOptions(select, within(select).getByRole('option', { name: title }));
};
const press = async (): Promise<void> => {
  await userEvent.click(runButton());
  await settle();
};

describe('running a built pattern', () => {
  it('shows Run pattern with its reason in the open builder, and Starts from once a type is chosen', async () => {
    await runWorkspace();
    expect(runButton().disabled).toBe(true);
    expect(runReason()).toBe('Complete the pattern first.');
    expect(screen.queryByLabelText('Starts from')).toBeNull();
    await chooseStart('n-a');
    expect(screen.getByLabelText('Starts from')).toBeTruthy();
  });

  it('says why it cannot run, in the order the person meets it: complete, checking, not valid, check failed, preview, start', async () => {
    let answer: ApiResult<{ status: 'ok' } | { status: 'invalid'; problems: { path: (string | number)[]; code: string }[] }> = { ok: true, value: { status: 'invalid', problems: [{ path: ['steps', 0], code: 'bad-value' }] } } as never;
    await runWorkspace({ validate: async () => answer as never, preview: () => new Promise(() => undefined) });
    await chooseStart('n-a');
    const { buildStep } = await import('./run-kit.js');
    await buildStep(1, 'out', 'n-b', ['r-1']);
    expect(runReason()).toBe('Checking the pattern…');
    await afterDebounce();
    expect(runReason()).toBe('The pattern is not valid.');
    answer = { ok: false, failure: failure('SOURCE_BUSY') };
    await userEvent.click(within(screen.getByRole('group', { name: 'Step 1' })).getByRole('checkbox', { name: 'r-2' }));
    await afterDebounce();
    expect(runReason()).toBe('The check could not be made.');
    answer = { ok: true, value: { status: 'ok' } };
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await afterDebounce();
    expect(runReason()).toBe('Wait for the preview.');
  });

  it('sends one run with the source, the definition as checked, the anchor and nothing else, with a fresh key each press', async () => {
    const kit = await runWorkspace();
    await validPattern();
    expect(runButton().disabled).toBe(false);
    await press();
    await press();
    expect(kit.definitionRuns).toHaveLength(2);
    const [first, second] = kit.definitionRuns;
    expect(first?.request).toEqual({ sourceId: 'a', definition: kit.validations[0]?.definition, anchor: { entityType: 'n-a', stableId: 'x-1' } });
    expect(first?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(second?.key).not.toBe(first?.key);
  });

  it('sends the mask when masking is on', async () => {
    const kit = await runWorkspace();
    act(() => kit.state.setMask(true));
    await settle();
    const { openBuilder } = await import('./run-kit.js');
    await openBuilder();
    await validPattern();
    await press();
    expect(kit.definitionRuns[0]?.request.mask).toBe(true);
  });

  it.each([
    [{ value: 3, quality: 'exact' as const, scope: 'matches' }, '3 · exact'],
    [{ value: 3, quality: 'estimated' as const, scope: 'matches' }, '~ 3 (estimated)'],
    [{ value: 3, quality: 'lowerBound' as const, scope: 'matches' }, '≥ 3 · lower bound'],
    [{ quality: 'unknown' as const, scope: 'matches' }, 'no count'],
  ])('states the count %j as %s and lists the match', async (count, text) => {
    await runWorkspace({ runDefinition: async () => ({ ok: true, value: definitionOk(['acc-2'], { count } as never) }) });
    await validPattern();
    await press();
    const result = screen.getByRole('region', { name: 'Result' });
    expect(within(result).getByRole('status').textContent).toBe(text);
    expect(within(result).getByRole('table')).toBeTruthy();
  });

  it('says no match was found and draws no table', async () => {
    await runWorkspace({ runDefinition: async () => ({ ok: true, value: definitionOk([]) }) });
    await validPattern();
    await press();
    const result = screen.getByRole('region', { name: 'Result' });
    expect(within(result).getByRole('status').textContent).toBe('No matches found. 0 · exact');
    expect(within(result).queryByRole('table')).toBeNull();
  });

  it('hides the result when the definition or the starting entity changes', async () => {
    await runWorkspace();
    await validPattern();
    await press();
    expect(screen.getByRole('region', { name: 'Result' })).toBeTruthy();
    await userEvent.click(within(screen.getByRole('group', { name: 'Step 1' })).getByRole('checkbox', { name: 'r-2' }));
    expect(screen.queryByRole('region', { name: 'Result' })).toBeNull();
    await afterDebounce();
    await press();
    expect(screen.getByRole('region', { name: 'Result' })).toBeTruthy();
    await pickStart('x-2');
    expect(screen.queryByRole('region', { name: 'Result' })).toBeNull();
  });
});

describe('the pattern in words', () => {
  it('asks once after the check says valid, with the same envelope, and shows each part as the server wrote it', async () => {
    const kit = await runWorkspace();
    await validPattern();
    expect(kit.previews).toHaveLength(1);
    expect(kit.previews[0]).toEqual({ sourceId: 'a', definition: kit.validations[0]?.definition });
    const preview = screen.getByRole('region', { name: 'Preview' });
    for (const text of ['Starts at an N-A.', 'Follows r-1 outgoing to an N-B.', 'At most 4 steps.', 'At most 50 results at a time.', 'Counts stop at 500.']) expect(within(preview).getByText(text)).toBeTruthy();
  });

  it('keeps Run disabled until the preview arrives, with the reason', async () => {
    let release: (answer: ApiResult<PatternPreviewResponse>) => void = () => undefined;
    await runWorkspace({ preview: () => new Promise((resolve) => (release = resolve)) });
    await validPattern();
    expect(runButton().disabled).toBe(true);
    expect(runReason()).toBe('Wait for the preview.');
    const { PREVIEW } = await import('../patterns-kit.js');
    act(() => release({ ok: true, value: { status: 'ok', preview: PREVIEW } }));
    await settle();
    expect(runButton().disabled).toBe(false);
    expect(runReason()).toBeUndefined();
  });

  it('clears the preview on a change and shows only the newest answer', async () => {
    const releases: Array<(answer: ApiResult<PatternPreviewResponse>) => void> = [];
    await runWorkspace({ preview: () => new Promise((resolve) => releases.push(resolve)) });
    await validPattern();
    await userEvent.click(within(screen.getByRole('group', { name: 'Step 1' })).getByRole('checkbox', { name: 'r-2' }));
    expect(screen.queryByRole('region', { name: 'Preview' })).toBeNull();
    await afterDebounce();
    expect(releases).toHaveLength(2);
    const { PREVIEW } = await import('../patterns-kit.js');
    act(() => releases[1]?.({ ok: true, value: { status: 'ok', preview: { ...PREVIEW, start: { ...PREVIEW.start, text: 'The newer words.' } } } }));
    act(() => releases[0]?.({ ok: true, value: { status: 'ok', preview: PREVIEW } }));
    await settle();
    expect(screen.getByText('The newer words.')).toBeTruthy();
    expect(screen.queryByText('Starts at an N-A.')).toBeNull();
  });

  it('says the preview could not be made, for a failure and for an invalid answer, with Retry, and keeps Run disabled', async () => {
    let answer: ApiResult<PatternPreviewResponse> = { ok: false, failure: failure('NOT_FOUND') };
    const kit = await runWorkspace({ preview: async () => answer });
    await validPattern();
    const area = screen.getAllByText('The preview could not be made.').map((node) => node.closest('[role="alert"]')).find((node) => node !== null) as HTMLElement;
    expect(area).toBeTruthy();
    expect(within(area).getByText('This was not found. It may have been removed.')).toBeTruthy();
    expect(runReason()).toBe('The preview could not be made.');
    answer = { ok: true, value: { status: 'invalid', problems: [{ path: ['steps'], code: 'bad-value' }] } };
    await userEvent.click(within(area).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(kit.previews).toHaveLength(2);
    expect(within(screen.getAllByText('The preview could not be made.').map((node) => node.closest('[role="alert"]')).find((node) => node !== null) as HTMLElement).getByText('This choice is not allowed.')).toBeTruthy();
    expect(runButton().disabled).toBe(true);
  });

  it('drops a preview on its way when the source changes', async () => {
    let signal: AbortSignal | undefined;
    const kit = await runWorkspace({ preview: (_request, aborted) => ((signal = aborted), new Promise(() => undefined)) });
    await validPattern();
    act(() => kit.state.bindSource('b'));
    await settle();
    expect(signal?.aborted).toBe(true);
  });
});

describe('a run in progress', () => {
  const held = () => {
    const runs: Array<{ answer: (result: Run) => void; signal: AbortSignal | undefined }> = [];
    const handler = (_request: unknown, _key: string, signal: AbortSignal | undefined): Promise<Run> =>
      new Promise((resolve) => {
        runs.push({ answer: resolve, signal });
        signal?.addEventListener('abort', () => resolve({ ok: false, failure: { code: 'ABORTED' } }));
      });
    return { runs, handler };
  };

  it('shows Running with the timeout and Cancel instead of Run, keeping the earlier result', async () => {
    const { runs, handler } = held();
    let first = true;
    await runWorkspace({ runDefinition: (request, key, signal) => (first ? ((first = false), Promise.resolve<Run>({ ok: true, value: definitionOk(['acc-2']) })) : handler(request, key, signal)) });
    await validPattern();
    await press();
    await press();
    expect(runs).toHaveLength(1);
    expect(screen.getByText('Running · 5 s timeout')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run pattern' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Result' })).toBeTruthy();
  });

  it('aborts on Cancel, says so with Run again, ignores a late answer and leaves the graph', async () => {
    const { runs, handler } = held();
    const kit = await runWorkspace({ runDefinition: handler });
    await validPattern();
    const nodes = kit.state.visibleGraph().nodes.length;
    await press();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(runs[0]?.signal?.aborted).toBe(true);
    expect(screen.getByText('Cancelled. No new matches shown.')).toBeTruthy();
    act(() => runs[0]?.answer({ ok: true, value: definitionOk(['acc-2']) }));
    await settle();
    expect(screen.queryByRole('region', { name: 'Result' })).toBeNull();
    expect(kit.state.visibleGraph().nodes).toHaveLength(nodes);
    await userEvent.click(screen.getByRole('button', { name: 'Run again' }));
    await settle();
    expect(runs).toHaveLength(2);
  });

  it('aborts the run when the definition or the starting entity changes, and drops it when the source changes', async () => {
    const { runs, handler } = held();
    const kit = await runWorkspace({ runDefinition: handler });
    await validPattern();
    await press();
    await pickStart('x-2');
    await settle();
    expect(runs[0]?.signal?.aborted).toBe(true);
    expect(screen.queryByText('Cancelled. No new matches shown.')).toBeNull();
    await press();
    act(() => kit.state.bindSource('b'));
    await settle();
    expect(runs[1]?.signal?.aborted).toBe(true);
  });

  it('raises no canvas banner in any state', async () => {
    let answer: Run = { ok: false, failure: failure('SOURCE_BUSY') };
    const kit = await runWorkspace({ runDefinition: async () => answer });
    await validPattern();
    await press();
    expect(kit.banner.view.getState().banner).toBeUndefined();
    answer = { ok: true, value: definitionHeavy() };
    await press();
    expect(kit.banner.view.getState().banner).toBeUndefined();
  });
});

describe('a run that fails', () => {
  it.each<[string, Record<string, number> | undefined, string, boolean, boolean]>([
    ['SOURCE_BUSY', undefined, 'is busy. No read slot freed within the wait.', true, true],
    ['SOURCE_UNAVAILABLE', undefined, 'unavailable. The loaded graph remains available.', true, true],
    ['QUERY_TIMEOUT', { timeoutMs: 5000 }, 'did not answer within 5 s.', true, true],
    ['QUERY_BUDGET_EXCEEDED', { maxHops: 2 }, 'The source allows at most 2 steps.', false, true],
    ['INVALID_REQUEST', undefined, 'The server did not accept this request.', false, false],
    ['NOT_FOUND', undefined, 'This was not found. It may have been removed.', false, false],
    ['CONFLICT', undefined, 'This was changed elsewhere. Reload it, then try again.', false, false],
    ['ACCESS_DENIED', undefined, 'You may not do this on this source.', false, false],
    ['INTERNAL_ERROR', undefined, 'Something went wrong on the server.', false, false],
  ])('shows the sentence of %s and offers Try again only where it can help (the error table sets the flag)', async (code, details, text, retry, tableFlag) => {
    const kit = await runWorkspace({ runDefinition: async () => ({ ok: false, failure: { ...failure(code, details), retryable: tableFlag } as never }) });
    await validPattern();
    await press();
    const alert = screen.getAllByRole('alert').find((node) => node.textContent?.includes(text));
    expect(alert, code).toBeTruthy();
    expect(within(alert as HTMLElement).queryAllByRole('button').length > 0).toBe(retry);
    expect(kit.state.visibleGraph().nodes.length).toBeGreaterThan(0);
  });

  it('counts down a rate limit and holds Try again, and says the answer was not in the form expected for a schema mismatch', async () => {
    await runWorkspace({ runDefinition: async () => ({ ok: false, failure: failure('RATE_LIMITED', { retryAfterMs: 3000 }) }) });
    await validPattern();
    await press();
    expect(screen.getByText('You can try again in 3 s.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Try again in 3 s' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    document.body.replaceChildren();
    await runWorkspace({ runDefinition: async () => ({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } as never }) });
    await validPattern();
    await press();
    expect(screen.getByText('The answer was not in the form expected.')).toBeTruthy();
  });

  it('does not say a field is set when a builder run is refused over its steps', async () => {
    await runWorkspace({ runDefinition: async () => ({ ok: false, failure: { ...failure('QUERY_BUDGET_EXCEEDED', { maxHops: 2 }), retryable: false } as never }) });
    await validPattern();
    await press();
    const alert = screen.getAllByRole('alert').find((node) => node.textContent?.includes('at most 2 steps'));
    expect(alert?.textContent).not.toMatch(/field/i);
  });

  it('keeps the earlier result and the builder after a failure', async () => {
    let call = 0;
    await runWorkspace({ runDefinition: async () => (++call === 1 ? { ok: true, value: definitionOk(['acc-2']) } : { ok: false, failure: failure('SOURCE_BUSY') }) });
    await validPattern();
    await press();
    await press();
    expect(screen.getByRole('region', { name: 'Result' })).toBeTruthy();
    expect(builderPanel().querySelector('#pattern-step-0-direction')).toBeTruthy();
  });
});
