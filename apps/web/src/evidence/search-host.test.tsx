import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { EdgeDetail, StoredEdgeRef } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { searchAt, searchKit, evidenceHit, withEvidence } from '../search/search-test-kit.js';
import { createClientState } from '../state/client-state.js';
import { renderApp } from '../test-utils.js';

afterEach(cleanup);

const BUTTON = 'View evidence: MADE_FROM L-1';

function rigged(sources: readonly string[] = ['demo']) {
  const kit = searchKit(sources, async (request) => withEvidence(request.sourceId, [], [evidenceHit('L-1', { sourceId: request.sourceId })]));
  const asked: Array<{ readonly ref: StoredEdgeRef; readonly mask: boolean; readonly signal: AbortSignal | undefined; readonly answer: (result: ApiResult<EdgeDetail>) => void }> = [];
  const client = { ...kit.client, getEdge: (ref: StoredEdgeRef, options?: { mask?: boolean }, signal?: AbortSignal) => new Promise<ApiResult<EdgeDetail>>((resolve) => void asked.push({ ref, mask: options?.mask === true, signal, answer: resolve })) };
  const state = createClientState();
  const view = renderApp(searchAt(sources[0] ?? 'demo', 'REC-1'), client, state);
  return { asked, state, view, kit };
}

const aside = () => screen.queryByRole('complementary', { name: 'Relationship evidence' });

describe('the evidence panel on the Search page', () => {
  it('opens in a column beside the results on View evidence, reading the edge by its reference, loading nothing and creating no investigation', async () => {
    const { asked, state, kit } = rigged();
    expect(aside()).toBeNull();
    await userEvent.setup().click(await screen.findByRole('button', { name: BUTTON }));
    expect(asked.map((call) => call.ref)).toEqual([{ sourceId: 'demo', type: 'MADE_FROM', from: 'kind-a', to: 'kind-a', stableId: 'L-1' }]);
    expect(within(screen.getByRole('complementary', { name: 'Relationship evidence' })).getByRole('status').textContent).toBe('Reading the evidence…');
    expect(state.loadedGraph().nodes).toEqual([]);
    expect(kit.opens).toEqual([]);
    await act(async () => undefined);
    expect(document.activeElement).toBe(within(screen.getByRole('complementary', { name: 'Relationship evidence' })).getByRole('tab', { name: 'Evidence' }));
  });

  it('closes with Esc inside it or its button and returns focus to the button of the row', async () => {
    const { asked } = rigged();
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: BUTTON });
    await user.click(button);
    await act(async () => undefined);
    await user.keyboard('{Escape}');
    expect(aside()).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(asked[0]?.signal?.aborted).toBe(true);
    await user.click(button);
    await user.click(within(screen.getByRole('complementary', { name: 'Relationship evidence' })).getByRole('button', { name: 'Close relationship evidence' }));
    expect(aside()).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('closes, drops what it held and aborts the read in flight when the masking changes', async () => {
    const { asked, state } = rigged();
    await userEvent.setup().click(await screen.findByRole('button', { name: BUTTON }));
    act(() => state.setMask(true));
    expect(aside()).toBeNull();
    expect(asked[0]?.signal?.aborted).toBe(true);
    await userEvent.setup().click(await screen.findByRole('button', { name: BUTTON }));
    act(() => state.setMask(false));
    await userEvent.setup().click(await screen.findByRole('button', { name: BUTTON }));
    expect(asked.map((call) => call.mask)).toEqual([false, true, false]);
  });

  it('closes and aborts the read in flight when the source of the page changes', async () => {
    const { asked } = rigged(['demo', 'other']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: BUTTON }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Source' }), 'other');
    expect(aside()).toBeNull();
    expect(asked[0]?.signal?.aborted).toBe(true);
  });

  it('shows the not-found state of the panel for an edge the source does not hold', async () => {
    const { asked } = rigged();
    await userEvent.setup().click(await screen.findByRole('button', { name: BUTTON }));
    await act(async () => asked[0]?.answer({ ok: false, failure: { code: 'NOT_FOUND', message: 'x', retryable: false, traceId: 'tr-1' } }));
    expect(within(screen.getByRole('complementary', { name: 'Relationship evidence' })).getByRole('alert').textContent).toContain('NOT_FOUND');
  });
});
