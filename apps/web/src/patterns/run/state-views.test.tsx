import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PATTERN_UNAVAILABLE_CODES } from '@neburyx/contracts';
import { definitionOk, failure, listed, openPatterns, patternsWorkspace, settle } from '../patterns-kit.js';
import { UNAVAILABLE_TEXT } from '../saved/saved-copy.js';
import { ran, runWorkspace, panelHeader, inRun } from './run-kit.js';
import { EmptyMine, ListUnreadable, OutOfDate } from './state-views.js';
import type { ApiFailure } from '../../api/client.js';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('no patterns of your own (PB19 state 5)', () => {
  it('says where to start with + New pattern and See built-in, instead of the panel’s own New pattern button', async () => {
    await patternsWorkspace();
    await openPatterns();
    const mine = within(screen.getByRole('region', { name: /My patterns/ }));
    expect(mine.getByText('Start from a built-in pattern, or create your own. Saved patterns appear here.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New pattern' })).toHaveLength(1);
    await userEvent.click(mine.getByRole('button', { name: 'See built-in' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: /^Built-in/ }));
  });

  it('opens the editor from + New pattern, and the panel’s own New pattern button comes back once a pattern of the person’s own exists', async () => {
    await patternsWorkspace();
    await openPatterns();
    await userEvent.click(screen.getByRole('button', { name: 'New pattern' }));
    expect(screen.getByRole('heading', { name: 'New pattern' })).toBeTruthy();
    cleanup();
    document.body.replaceChildren();
    await patternsWorkspace({ patterns: { listPatterns: async () => ({ ok: true, value: { items: [listed({ id: '0192f000-0000-7000-8000-000000000001', name: 'Alpha' })], nextCursor: null } }) } });
    await openPatterns();
    expect(screen.getAllByRole('button', { name: 'New pattern' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'See built-in' })).toBeNull();
  });

  it('draws the two buttons on their own', () => {
    const calls: string[] = [];
    render(<EmptyMine onNew={() => calls.push('new')} onSeeBuiltIn={() => calls.push('built-in')} />);
    act(() => screen.getByRole('button', { name: 'New pattern' }).click());
    act(() => screen.getByRole('button', { name: 'See built-in' }).click());
    expect(calls).toEqual(['new', 'built-in']);
  });
});

describe('a list that cannot be read (PB19 state 2)', () => {
  it('says why in the words of the table with Try again, and reads the list again on it', async () => {
    let reads = 0;
    await patternsWorkspace({ patterns: { listPatterns: async () => (++reads === 1 ? { ok: false, failure: failure('SOURCE_BUSY') } : { ok: true, value: { items: [], nextCursor: null } }) } });
    await openPatterns();
    expect(screen.getAllByRole('alert').map((entry) => entry.textContent).join(' ')).toMatch(/busy/i);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(reads).toBe(2);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('counts the wait of a rate limit down from retryAfterMs and turns Try again on when it is over', async () => {
    const limited = failure('RATE_LIMITED', { retryAfterMs: 3000 }) as ApiFailure;
    render(<ListUnreadable failure={limited} sourceName="A source" retry={() => undefined} />);
    expect(screen.getByText('You can try again in 3 s.')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Try again in 3 s' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    for (let second = 0; second < 3; second++) await act(async () => void (await vi.advanceTimersByTimeAsync(1100)));
    expect(screen.getByText('You can try again now.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('a run refused for too many requests (PB19 state 3)', () => {
  it('counts down on the start screen, where the run was pressed, and keeps the draft', async () => {
    await runWorkspace({ runDefinition: async () => ({ ok: false, failure: failure('RATE_LIMITED', { retryAfterMs: 8000 }) }) });
    await ran();
    expect(inRun().getByText('You can try again in 8 s.')).toBeTruthy();
    expect((inRun().getByRole('button', { name: 'Try again in 8 s' }) as HTMLButtonElement).disabled).toBe(true);
    for (let second = 0; second < 2; second++) await act(async () => void (await vi.advanceTimersByTimeAsync(1100)));
    expect(inRun().getByText('You can try again in 6 s.')).toBeTruthy();
    expect(panelHeader().title).toBe('Preview pattern');
  });
});

describe('a run refused for too many steps', () => {
  it('names the limit of the source from the answer, without the code', async () => {
    await runWorkspace({ runDefinition: async () => ({ ok: false, failure: failure('QUERY_BUDGET_EXCEEDED', { maxHops: 2 }) }) });
    await ran();
    expect(inRun().getByText('The source allows at most 2 steps.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('QUERY_BUDGET_EXCEEDED');
  });
});

describe('a result with no match, and the footer line about counts', () => {
  it('says 0 matches with the label Exact, what to try, and the line that counts are always labelled', async () => {
    await runWorkspace({ runDefinition: async () => ({ ok: true, value: definitionOk([]) }) });
    await ran();
    expect(inRun().getByText('0 matches')).toBeTruthy();
    expect(inRun().getByText('Exact')).toBeTruthy();
    expect(inRun().getByText(/^Nothing in this source follows this pattern from /)).toBeTruthy();
    expect(inRun().getByText('Counts are always labelled Exact, Lower bound or Estimated. When a count is unknown, no number is shown.')).toBeTruthy();
  });

  it('shows no number for a count that is not known', async () => {
    await runWorkspace({ runDefinition: async () => ({ ok: true, value: definitionOk(['acc-2'], { count: { quality: 'unknown', scope: 'matches' } }) }) });
    await ran();
    expect(inRun().getByText('The number of matches is not known')).toBeTruthy();
    expect(inRun().queryByText(/^(At least|About) /)).toBeNull();
  });
});

describe('the pattern that is out of date (PB19 state 8)', () => {
  it('says a sentence for each reason and step, with Run off, and the way to fix it that fits whose pattern it is', () => {
    const reasons = [{ code: 'unknown-property' as const, path: ['steps', 0, 'conditions', 0] }, { code: 'unknown-entity-type' as const }];
    const calls: string[] = [];
    const { rerender } = render(<OutOfDate reasons={reasons} offer="change" onChange={() => calls.push('change')} onCopyAndChange={() => calls.push('copy')} />);
    expect(screen.getByText('Pattern out of date')).toBeTruthy();
    expect(screen.getByText(`${UNAVAILABLE_TEXT['unknown-property']} (step 1)`)).toBeTruthy();
    expect(screen.getByText(UNAVAILABLE_TEXT['unknown-entity-type'])).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Run pattern' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => screen.getByRole('button', { name: 'Change pattern' }).click());
    expect(screen.queryByRole('button', { name: 'Copy and change' })).toBeNull();
    rerender(<OutOfDate reasons={reasons} offer="copy" onChange={() => calls.push('change')} onCopyAndChange={() => calls.push('copy')} />);
    expect(screen.getByText('A pattern shared by someone else can be copied first.')).toBeTruthy();
    act(() => screen.getByRole('button', { name: 'Copy and change' }).click());
    expect(calls).toEqual(['change', 'copy']);
    rerender(<OutOfDate reasons={reasons} offer={undefined} onChange={() => undefined} onCopyAndChange={() => undefined} />);
    expect(screen.queryByRole('button', { name: /change/i })).toBeNull();
  });

  it('has a sentence for every reason code, none of which holds a code', () => {
    render(<OutOfDate reasons={PATTERN_UNAVAILABLE_CODES.map((code) => ({ code }))} offer="change" onChange={() => undefined} onCopyAndChange={() => undefined} />);
    for (const code of PATTERN_UNAVAILABLE_CODES) expect(screen.getByText(UNAVAILABLE_TEXT[code])).toBeTruthy();
  });
});
