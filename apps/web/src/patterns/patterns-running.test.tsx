import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiResult } from '../api/client.js';
import type { TemplateRunResponse } from '@neburyx/contracts';
import { failure, heavyRun, okRun, openPatterns, patternsWorkspace, selectAccount, settle, type Sent } from './patterns-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const run = (): HTMLElement => screen.getByRole('button', { name: 'Run pattern' });
type Answer = ApiResult<TemplateRunResponse>;

interface Held {
  readonly sent: Sent;
  readonly answer: (result: Answer) => void;
}

/** A run that waits until the test answers it, and that ends as aborted when its signal is aborted, as the client's does. */
function holdingRuns() {
  const held: Held[] = [];
  const handler = (sent: Sent): Promise<Answer> =>
    new Promise((resolve) => {
      held.push({ sent, answer: resolve });
      sent.signal?.addEventListener('abort', () => resolve({ ok: false, failure: { code: 'ABORTED' } }));
    });
  return { held, handler };
}

describe('running, cancel and stale answers', () => {
  it('shows Running with the timeout, Cancel instead of Run, and the previous result', async () => {
    const { held, handler } = holdingRuns();
    let first = true;
    const kit = await patternsWorkspace({ run: (sent) => (first ? ((first = false), Promise.resolve({ ok: true as const, value: okRun(['acc-2']) })) : handler(sent)) });
    await openPatterns();
    selectAccount(kit.state, 'acc-1');
    await userEvent.click(run());
    await settle();
    await userEvent.click(run());
    await settle();
    expect(held).toHaveLength(1);
    expect(screen.getByText('Running · 5 s timeout')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run pattern' })).toBeNull();
    expect(within(screen.getByRole('table')).getByText('acc-2')).toBeTruthy();
  });

  it('aborts on Cancel, shows the cancelled line with Run again, ignores a late answer and leaves the graph', async () => {
    const { held, handler } = holdingRuns();
    const kit = await patternsWorkspace({ run: handler });
    await openPatterns();
    selectAccount(kit.state, 'acc-1');
    const nodes = kit.state.visibleGraph().nodes.length;
    await userEvent.click(run());
    await settle();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(held[0]?.sent.signal?.aborted).toBe(true);
    expect(screen.getByText('Cancelled. No new matches shown.')).toBeTruthy();
    act(() => held[0]?.answer({ ok: true, value: okRun(['acc-2']) }));
    await settle();
    expect(screen.queryByRole('table')).toBeNull();
    expect(kit.state.visibleGraph().nodes).toHaveLength(nodes);
    await userEvent.click(screen.getByRole('button', { name: 'Run again' }));
    await settle();
    expect(held).toHaveLength(2);
  });

  it('cancels on Escape while running and closes the panel on Escape when idle', async () => {
    const { held, handler } = holdingRuns();
    const kit = await patternsWorkspace({ run: handler });
    await openPatterns();
    selectAccount(kit.state, 'acc-1');
    await userEvent.click(run());
    await settle();
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Shared devices' }), { key: 'Escape' });
    await settle();
    expect(held[0]?.sent.signal?.aborted).toBe(true);
    expect(screen.getByRole('heading', { name: 'Patterns' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Shared devices' }), { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('heading', { name: 'Patterns' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Patterns' }));
  });

  it('shows only the newer run’s answer when a run is started over a running one', async () => {
    const { held, handler } = holdingRuns();
    const kit = await patternsWorkspace({ run: handler });
    await openPatterns();
    selectAccount(kit.state, 'acc-1');
    await userEvent.click(run());
    await settle();
    await userEvent.click(screen.getByRole('radio', { name: 'Shared addresses' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(run());
    await settle();
    expect(held[0]?.sent.signal?.aborted).toBe(true);
    act(() => held[0]?.answer({ ok: true, value: okRun(['old-1']) }));
    act(() => held[1]?.answer({ ok: true, value: okRun(['new-1']) }));
    await settle();
    const table = screen.getByRole('table');
    expect(within(table).getByText('new-1')).toBeTruthy();
    expect(within(table).queryByText('old-1')).toBeNull();
  });

  it('drops the run when the source changes, and shows nothing of its answer in the new context', async () => {
    const { held, handler } = holdingRuns();
    const kit = await patternsWorkspace({ run: handler });
    await openPatterns();
    selectAccount(kit.state, 'acc-1');
    await userEvent.click(run());
    await settle();
    act(() => kit.state.bindSource('b'));
    await settle();
    expect(held[0]?.sent.signal?.aborted).toBe(true);
    act(() => held[0]?.answer({ ok: true, value: okRun(['acc-2']) }));
    await settle();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('raises no canvas banner while running, cancelled, failed, busy or heavy', async () => {
    let answer: Answer = { ok: false, failure: failure('SOURCE_BUSY') };
    const kit = await patternsWorkspace({ run: async () => answer });
    await openPatterns();
    selectAccount(kit.state, 'acc-1');
    const shown = (): unknown => kit.banner.view.getState().banner;
    await userEvent.click(run());
    await settle();
    expect(shown()).toBeUndefined();
    answer = { ok: false, failure: failure('INTERNAL_ERROR') };
    await userEvent.click(run());
    await settle();
    expect(shown()).toBeUndefined();
    answer = { ok: true, value: heavyRun() };
    await userEvent.click(run());
    await settle();
    expect(shown()).toBeUndefined();
  });
});
