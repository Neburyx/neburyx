import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiResult } from '../api/client.js';
import type { PatternRunResponse, SavedPatternRunResponse, TemplateRunResponse } from '@neburyx/contracts';
import { definitionOk, failure, heavyRun, listed, okRun, openBuiltIn, openPatterns, patternsWorkspace, selectAccount, settle } from './patterns-kit.js';
import { inRun, ran, runButton, runWorkspace } from './run/run-kit.js';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const NOTE = 'This is the result of the earlier run. The last run gave no result.';
const BUSY = { ok: false, failure: failure('SOURCE_BUSY') } as const;

describe('an earlier result under a run that gave none', () => {
  it('is labelled as the earlier result in the built-in patterns when the next run fails, stops as heavy or is cancelled, and the label goes with the next result', async () => {
    const answers: Array<ApiResult<TemplateRunResponse> | 'hold'> = [{ ok: true, value: okRun(['acc-2']) }, BUSY, { ok: true, value: heavyRun() }, 'hold', { ok: true, value: okRun(['acc-2']) }];
    let next = 0;
    const kit = await patternsWorkspace({
      run: (sent) => {
        const answer = answers[next++];
        if (answer !== 'hold' && answer !== undefined) return Promise.resolve(answer);
        return new Promise((resolve) => sent.signal?.addEventListener('abort', () => resolve({ ok: false, failure: { code: 'ABORTED' } })));
      },
    });
    await openBuiltIn();
    selectAccount(kit.state, 'acc-1');
    const run = (): Promise<void> => userEvent.click(screen.getByRole('button', { name: 'Run pattern' }));
    await run();
    await settle();
    expect(screen.getByRole('region', { name: 'Result' })).toBeTruthy();
    expect(screen.queryByText(NOTE)).toBeNull();
    await run();
    await settle();
    expect(screen.getByText(NOTE)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Result' })).toBeTruthy();
    await run();
    await settle();
    expect(screen.getByText(NOTE)).toBeTruthy();
    await run();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(screen.getByText(NOTE)).toBeTruthy();
    await run();
    await settle();
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it('is not carried into a run of a built pattern: a failed next run shows its refusal on the preview, with no earlier result under it', async () => {
    let calls = 0;
    await runWorkspace({ runDefinition: async () => (++calls === 1 ? { ok: true, value: definitionOk(['acc-2']) as PatternRunResponse } : BUSY) });
    await ran();
    expect(inRun().getByRole('list', { name: 'Matches' })).toBeTruthy();
    await userEvent.click(inRun().getByRole('button', { name: 'Edit pattern' }));
    await userEvent.click(screen.getByRole('button', { name: /^Preview/ }));
    await settle();
    await userEvent.click(runButton());
    await settle();
    expect(inRun().getByText(/is busy/)).toBeTruthy();
    expect(screen.queryByText(NOTE)).toBeNull();
    expect(inRun().queryByRole('list', { name: 'Matches' })).toBeNull();
  });

  it('is labelled under a saved pattern when its next run fails', async () => {
    let calls = 0;
    await patternsWorkspace({
      patterns: {
        listPatterns: async () => ({ ok: true, value: { items: [listed({ id: '0192f000-0000-7000-8000-000000000001', name: 'Alpha' })], nextCursor: null } }),
        runSavedPattern: async () => (++calls === 1 ? { ok: true, value: definitionOk(['acc-2']) as SavedPatternRunResponse } : BUSY),
      },
    });
    await openPatterns();
    await userEvent.click(screen.getByRole('button', { name: 'Run Alpha' }));
    await settle();
    expect(screen.queryByText(NOTE)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Run Alpha' }));
    await settle();
    expect(screen.getByText(NOTE)).toBeTruthy();
  });
});

