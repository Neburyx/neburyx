import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { failure, listOf, okRun, openPatterns, patternsWorkspace, selectAccount, settle, type KitOptions } from './patterns-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const run = (): HTMLElement => screen.getByRole('button', { name: 'Run pattern' });

async function ran(options: KitOptions) {
  const kit = await patternsWorkspace(options);
  await openPatterns();
  selectAccount(kit.state, 'acc-1');
  await userEvent.click(run());
  await settle();
  return kit;
}

describe('the Patterns panel: empty, failure and source-state answers', () => {
  it('says the source has no patterns and draws no card and no Run when the list holds only the generic templates', async () => {
    await patternsWorkspace({ list: async () => ({ ok: true, value: listOf([]) }) });
    await openPatterns();
    expect(screen.getByText('This source has no patterns.')).toBeTruthy();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Run pattern' })).toBeNull();
  });

  it('shows a failed list with Retry, leaves the graph alone and loads again on Retry', async () => {
    let calls = 0;
    const kit = await patternsWorkspace({ list: async () => (++calls === 1 ? { ok: false, failure: failure('SOURCE_BUSY') } : { ok: true, value: listOf() }) });
    const before = kit.state.visibleGraph().nodes.length;
    await openPatterns();
    expect(screen.getByRole('alert').textContent).toContain('is busy');
    expect(kit.state.visibleGraph().nodes).toHaveLength(before);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('keeps the earlier table, the fields and the graph when a later run fails', async () => {
    let call = 0;
    const kit = await ran({ run: async () => (++call === 1 ? { ok: true, value: okRun(['acc-2']) } : { ok: false, failure: failure('INTERNAL_ERROR') }) });
    const nodes = kit.state.visibleGraph().nodes.length;
    await userEvent.click(run());
    await settle();
    expect(screen.getAllByRole('alert')[0]?.textContent).toContain('INTERNAL_ERROR');
    expect(screen.getByRole('table')).toBeTruthy();
    expect(kit.state.visibleGraph().nodes).toHaveLength(nodes);
  });

  it.each([
    ['SOURCE_BUSY', undefined, 'is busy. No read slot freed within the wait.', 'Loaded graph and filters preserved; nothing was read. Retry when ready.', 'Retry'],
    ['RATE_LIMITED', { retryAfterMs: 12000 }, 'Too many requests. Retry after 12 s.', 'Loaded graph and filters preserved; nothing was read. The wait is set by the server.', 'Retry in 12 s'],
    ['SOURCE_UNAVAILABLE', undefined, 'unavailable. The loaded graph remains available.', 'Filters and saved view preserved; retry does not discard the graph.', 'Retry'],
    ['QUERY_TIMEOUT', { timeoutMs: 5000 }, 'did not answer within 5 s.', 'Loaded graph and filters preserved; nothing was merged. Retry when ready.', 'Retry'],
  ])('shows the §13 text, its explanation line and the recovery action for %s', async (code, details, text, line, action) => {
    await ran({ run: async () => ({ ok: false, failure: failure(code, details) }) });
    const alert = screen.getAllByRole('alert')[0];
    expect(alert?.textContent).toContain(text);
    expect(alert?.textContent).toContain(line);
    expect(screen.getByRole('button', { name: action })).toBeTruthy();
  });

  it('holds the Retry of a rate limit until the server’s wait is over, counting down, and announces it once', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const kit = await patternsWorkspace({ run: async () => ({ ok: false, failure: failure('RATE_LIMITED', { retryAfterMs: 3000 }) }) });
    await openPatterns();
    selectAccount(kit.state, 'acc-1');
    await userEvent.click(run());
    await settle();
    const retry = (): HTMLButtonElement => screen.getByRole('button', { name: /^Retry/ });
    expect(retry().textContent).toBe('Retry in 3 s');
    expect(retry().disabled).toBe(true);
    expect(screen.getByText('Too many requests. Retry after 3 s.')).toBeTruthy();
    const lines = screen.getAllByRole('alert')[0]?.querySelectorAll('p, button') ?? [];
    expect([...lines].map((line) => line.tagName)).toEqual(['P', 'P', 'BUTTON']);
    expect(lines[0]?.textContent).toBe('Too many requests. Retry after 3 s.');
    expect(lines[1]?.textContent).toContain('The wait is set by the server');
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect(retry().textContent).toBe('Retry in 2 s');
    expect(screen.getByText('Too many requests. Retry after 2 s.')).toBeTruthy();
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect(retry().textContent).toBe('Retry in 1 s');
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect(retry().textContent).toBe('Retry');
    expect(retry().disabled).toBe(false);
    expect(screen.getAllByText('Too many requests. You can retry now.')).toHaveLength(1);
    expect(screen.queryByText(/Retry after/)).toBeNull();
  });

  it('shows no number and no countdown, and an enabled Retry, for a rate limit with no wait given', async () => {
    await ran({ run: async () => ({ ok: false, failure: failure('RATE_LIMITED') }) });
    expect(screen.getAllByText('Too many requests. You can retry now.')).toHaveLength(1);
    expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('names the page cap of QUERY_BUDGET_EXCEEDED and sets the limit field to it', async () => {
    await ran({ run: async () => ({ ok: false, failure: failure('QUERY_BUDGET_EXCEEDED', { maxPage: 50 }) }) });
    expect(screen.getAllByRole('alert')[0]?.textContent).toContain('at most 50');
    expect((screen.getByLabelText('Max matching accounts') as HTMLInputElement).value).toBe('50');
  });

  it('names the hop cap and sets the hops field to it', async () => {
    const kit = await patternsWorkspace({ run: async () => ({ ok: false, failure: failure('QUERY_BUDGET_EXCEEDED', { maxHops: 1 }) }) });
    await openPatterns();
    selectAccount(kit.state, 'acc-1');
    await userEvent.click(screen.getByRole('radio', { name: 'Connected accounts' }));
    await userEvent.click(run());
    await settle();
    expect(screen.getAllByRole('alert')[0]?.textContent).toContain('at most 1');
    expect((screen.getByLabelText('Hops') as HTMLInputElement).value).toBe('1');
  });

  it('shows the SCHEMA_MISMATCH text for an answer that does not parse and keeps the earlier table', async () => {
    let call = 0;
    const kit = await ran({ run: async () => (++call === 1 ? { ok: true, value: okRun(['acc-2']) } : { ok: false, failure: { code: 'SCHEMA_MISMATCH' } }) });
    const nodes = kit.state.visibleGraph().nodes.length;
    await userEvent.click(run());
    await settle();
    expect(screen.getAllByRole('alert')[0]?.textContent).toContain('SCHEMA_MISMATCH');
    expect(screen.getByRole('table')).toBeTruthy();
    expect(kit.state.visibleGraph().nodes).toHaveLength(nodes);
  });
});
