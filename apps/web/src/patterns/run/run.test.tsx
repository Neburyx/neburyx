import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PatternPreviewResponse, PatternRunResponse } from '@neburyx/contracts';
import type { ApiResult } from '../../api/client.js';
import { PREVIEW, definitionOk, failure, settle } from '../patterns-kit.js';
import { afterDebounce, buildStep, chooseEntity, chooseStart, cleanup, inRun, openBuilder, panelHeader, previewed, ran, runButton, runCancel, runWorkspace, screen, toggleType, userEvent, validPattern, within } from './run-kit.js';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

type Run = ApiResult<PatternRunResponse>;
const previewButton = (): HTMLButtonElement => screen.getByRole('button', { name: /^Preview/ }) as HTMLButtonElement;

describe('running a built pattern', () => {
  it('has no Run pattern in the editor: Preview opens the screen where the run is, and stays off until the pattern is whole and checked', async () => {
    await runWorkspace();
    expect(previewButton().disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Run pattern' })).toBeNull();
    await chooseStart('n-a');
    expect(previewButton().disabled).toBe(true);
    await validPattern();
    expect(previewButton().disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Run pattern' })).toBeNull();
    await userEvent.click(previewButton());
    await settle();
    expect(runButton()).toBeTruthy();
  });

  it('keeps Preview off while the check is on its way, when the pattern is not valid and when the check could not be made', async () => {
    let answer: ApiResult<{ status: 'ok' } | { status: 'invalid'; problems: { path: (string | number)[]; code: string }[] }> = { ok: true, value: { status: 'invalid', problems: [{ path: ['steps', 0], code: 'bad-value' }] } } as never;
    await runWorkspace({ validate: async () => answer as never });
    await chooseStart('n-a');
    await buildStep(1, 'out', 'n-b', ['r-1']);
    expect(previewButton().disabled).toBe(true);
    await afterDebounce();
    expect(previewButton().disabled).toBe(true);
    answer = { ok: false, failure: failure('SOURCE_BUSY') };
    await toggleType(1, 'r-2');
    await afterDebounce();
    expect(previewButton().disabled).toBe(true);
    answer = { ok: true, value: { status: 'ok' } };
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await afterDebounce();
    expect(previewButton().disabled).toBe(false);
  });

  it('sends one run with the source, the definition as checked, the anchor and nothing else, with a fresh key each time', async () => {
    const kit = await runWorkspace({ runDefinition: async () => ({ ok: false, failure: failure('SOURCE_BUSY') }) });
    await ran();
    await userEvent.click(inRun().getByRole('button', { name: 'Try again' }));
    await settle();
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
    await openBuilder();
    await ran();
    expect(kit.definitionRuns[0]?.request.mask).toBe(true);
  });

  it.each([
    [{ value: 3, quality: 'exact' as const, scope: 'matches' }, '3 matches', 'Exact'],
    [{ value: 3, quality: 'estimated' as const, scope: 'matches' }, 'About 3 matches', 'Estimated'],
    [{ value: 3, quality: 'lowerBound' as const, scope: 'matches' }, 'At least 3 matches', 'Lower bound'],
    [{ quality: 'unknown' as const, scope: 'matches' }, 'The number of matches is not known', undefined],
  ])('states the count %j as %s and lists the match', async (count, headline, label) => {
    await runWorkspace({ runDefinition: async () => ({ ok: true, value: definitionOk(['acc-2'], { count } as never) }) });
    await ran();
    expect(inRun().getByText(headline)).toBeTruthy();
    if (label !== undefined) expect(inRun().getByText(label)).toBeTruthy();
    expect(inRun().getByRole('list', { name: 'Matches' })).toBeTruthy();
  });

  it('says no match was found and draws no card', async () => {
    await runWorkspace({ runDefinition: async () => ({ ok: true, value: definitionOk([]) }) });
    await ran();
    expect(inRun().getByText('0 matches')).toBeTruthy();
    expect(inRun().queryByRole('list', { name: 'Matches' })).toBeNull();
  });

  it('shows no result under a changed pattern or another starting entity: the preview comes first, and a new run asks again', async () => {
    const kit = await runWorkspace();
    await ran();
    expect(panelHeader().title).toBe('Pattern result');
    await userEvent.click(inRun().getByRole('button', { name: 'Edit pattern' }));
    await toggleType(1, 'r-2');
    await afterDebounce();
    await userEvent.click(previewButton());
    await settle();
    expect(panelHeader().title).toBe('Preview pattern');
    expect(inRun().queryByRole('list', { name: 'Matches' })).toBeNull();
    await chooseEntity('x-2');
    await userEvent.click(runButton());
    await settle();
    expect(kit.definitionRuns).toHaveLength(2);
    expect(kit.definitionRuns[1]?.request.anchor).toEqual({ entityType: 'n-a', stableId: 'x-2' });
  });
});

describe('the pattern in words', () => {
  it('asks once after the check says valid, with the same envelope, and shows each part as the server wrote it', async () => {
    const kit = await runWorkspace();
    await previewed();
    expect(kit.previews).toHaveLength(1);
    expect(kit.previews[0]).toEqual({ sourceId: 'a', definition: kit.validations[0]?.definition });
    const words = inRun().getByRole('region', { name: 'In plain words' });
    for (const text of ['Starts at an N-A.', 'Follows r-1 outgoing to an N-B.']) expect(within(words).getByText(text)).toBeTruthy();
  });

  it('keeps Run off until the preview arrives', async () => {
    let release: (answer: ApiResult<PatternPreviewResponse>) => void = () => undefined;
    await runWorkspace({ preview: () => new Promise((resolve) => (release = resolve)) });
    await previewed();
    expect(runButton().disabled).toBe(true);
    act(() => release({ ok: true, value: { status: 'ok', preview: PREVIEW } }));
    await settle();
    expect(runButton().disabled).toBe(false);
  });

  it('shows the words of the draft as it was when Preview was pressed, and asks again for a changed one', async () => {
    const kit = await runWorkspace({ preview: async (request) => ({ ok: true, value: { status: 'ok', preview: { ...PREVIEW, start: { ...PREVIEW.start, text: `Words for ${request.definition['steps'] === undefined ? '' : (request.definition['steps'] as unknown[]).length} step` } } } }) });
    await previewed();
    expect(inRun().getByText('Words for 1 step')).toBeTruthy();
    await userEvent.click(inRun().getByRole('button', { name: /Edit$/ }));
    await toggleType(1, 'r-2');
    await afterDebounce();
    await userEvent.click(previewButton());
    await settle();
    expect(kit.previews).toHaveLength(2);
    expect(JSON.stringify(kit.previews[1]?.definition)).toContain('r-2');
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

  it('shows Cancel run instead of Run pattern while it is on its way', async () => {
    const { handler } = held();
    await runWorkspace({ runDefinition: handler });
    await ran();
    expect(runCancel()).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run pattern' })).toBeNull();
  });

  it('aborts the run when the panel is closed', async () => {
    const { runs, handler } = held();
    await runWorkspace({ runDefinition: handler });
    await ran();
    await userEvent.click(screen.getByRole('button', { name: 'Close Patterns' }));
    await settle();
    expect(runs[0]?.signal?.aborted).toBe(true);
  });
});

describe('a run that fails', () => {
  it('says the answer was not in the form expected for a schema mismatch', async () => {
    await runWorkspace({ runDefinition: async () => ({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } as never }) });
    await ran();
    expect(inRun().getByText('The answer was not in the form expected.')).toBeTruthy();
  });

  it('does not say a field is set when a builder run is refused over its steps', async () => {
    await runWorkspace({ runDefinition: async () => ({ ok: false, failure: { ...failure('QUERY_BUDGET_EXCEEDED', { maxHops: 2 }), retryable: false } as never }) });
    await ran();
    const alert = inRun().getAllByRole('alert').find((node) => node.textContent?.includes('at most 2 steps'));
    expect(alert?.textContent).not.toMatch(/field/i);
  });

  it('keeps the draft after a failure: Edit returns to the editor as it was', async () => {
    await runWorkspace({ runDefinition: async () => ({ ok: false, failure: failure('SOURCE_BUSY') }) });
    await ran();
    await userEvent.click(inRun().getByRole('button', { name: /Edit$/ }));
    await settle();
    expect(within(screen.getByRole('region', { name: 'New pattern' })).getByRole('radio', { name: 'Outgoing' })).toBeTruthy();
  });
});
