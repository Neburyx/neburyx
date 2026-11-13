import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PatternRunResponse } from '@neburyx/contracts';
import type { ApiResult } from '../../api/client.js';
import { definitionOk } from '../patterns-kit.js';
import { cleanup, inRun, ran, runCancel, runWorkspace } from './run-kit.js';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

type Run = ApiResult<PatternRunResponse>;
const never = (): Promise<Run> => new Promise(() => undefined);

describe('what the run screens announce', () => {
  it('announces Running in a polite region that does not change while the seconds tick, and keeps the focus on Cancel run', async () => {
    await runWorkspace({ runDefinition: never });
    await ran();
    const status = inRun().getByRole('status');
    expect(status.textContent).toBe('Running');
    expect(status.getAttribute('aria-live')).not.toBe('assertive');
    expect(inRun().getByText('0 s elapsed. Large sources can take longer.')).toBeTruthy();
    await act(async () => void (await vi.advanceTimersByTimeAsync(5000)));
    expect(inRun().getByText('5 s elapsed. Large sources can take longer.')).toBeTruthy();
    expect(status.textContent).toBe('Running');
    expect(document.activeElement).toBe(runCancel());
  });

  it('announces an exact count as "n matches" with its Exact label in one status', async () => {
    await runWorkspace({ runDefinition: async () => ({ ok: true, value: definitionOk(['acc-2', 'acc-3']) }) });
    await ran();
    const status = inRun().getByRole('status', { name: '' });
    expect(status.textContent).toBe('2 matches · Exact');
  });

  it('announces a lower-bound count as "At least n matches" with its Lower bound label in one status', async () => {
    await runWorkspace({ runDefinition: async () => ({ ok: true, value: definitionOk(['acc-2'], { count: { value: 25, quality: 'lowerBound', scope: 'matches' } } as never) }) });
    await ran();
    expect(inRun().getByRole('status', { name: '' }).textContent).toBe('At least 25 matches · Lower bound');
  });
});
