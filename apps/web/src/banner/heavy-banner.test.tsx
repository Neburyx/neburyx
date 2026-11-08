import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Count, DegreePreview, DegreePreviewRequest, ExpandRequest, ExpandResponse } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiFailure, ApiResult } from '../api/client.js';
import { createExpandStore } from '../api/expand-store.js';
import { fakeClient } from '../api/fake-client.js';
import { createHeavyGuard } from '../api/heavy-guard.js';
import { createPreviewStore } from '../api/preview-store.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { edge, node, ref } from '../state/test-data.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import { ExpandProvider } from '../workspace/expand-context.js';
import { BannerProvider } from './banner-context.js';
import { bannerReporter } from './banner-reporter.js';
import { bindBannerToInvestigation } from './bind-investigation.js';
import { createBuiltInBannerController } from './built-in-causes.js';
import { StatusBanner } from './status-banner.js';

afterEach(() => cleanup());

const count = (value: number | undefined, quality: Count['quality'] = 'exact'): Count => (value === undefined ? { quality: 'unknown', scope: 'x' } : { value, quality, scope: 'x' });
const previewOf = (id: string, c: Count, overrides: Partial<DegreePreview> = {}): DegreePreview => ({
  ref: ref('a', 'type-a', id),
  total: c,
  byType: [{ relationshipType: 'link-a', direction: 'out', count: c, neighborTypes: ['kind-b'] }],
  byNeighborType: [],
  warnings: [],
  pageSize: 25,
  heavyOpThreshold: 500,
  ...overrides,
});
const page = (id: string): ExpandResponse => ({
  ref: ref('a', 'type-a', id),
  pageSize: 25,
  nodes: [node('a', `${id}-x`)],
  edges: [edge('a', `e-${id}`, id, `${id}-x`)],
  pages: [{ neighborType: 'kind-b', returned: 1, hasMore: false, matchingTotal: { value: 1, quality: 'exact', scope: 'expand:kind-b' } }],
  warnings: [],
});
const busy: ApiFailure = { code: 'SOURCE_BUSY', message: 'x', retryable: true, traceId: 'tr-busy' };
const n1 = ref('a', 'type-a', 'n1');
const n2 = ref('a', 'type-a', 'n2');

interface Asked<B, T> {
  readonly body: B;
  answer(result: ApiResult<T>): void;
}

function rig() {
  const expansions: Asked<ExpandRequest, ExpandResponse>[] = [];
  const previews: Asked<DegreePreviewRequest, DegreePreview>[] = [];
  const state = createClientState();
  loadGraph(state, [node('a', 'n1'), node('a', 'n2')], []);
  const banner = createBuiltInBannerController();
  bindBannerToInvestigation(state, banner);
  const client = fakeClient({
    expandNeighbors: (body) => new Promise((resolve) => void expansions.push({ body, answer: resolve })),
    previewExpansion: (body) => new Promise((resolve) => void previews.push({ body, answer: resolve })),
  });
  const report = bannerReporter(banner, (sourceId) => (sourceId === 'a' ? 'Demo source' : sourceId));
  const previewStore = createPreviewStore(client, () => 'person-1', report);
  const expand = createExpandStore(client, state, () => 'person-1', report, createHeavyGuard(previewStore, banner, state));
  render(
    <ClientStateProvider state={state}>
      <BannerProvider controller={banner}>
        <StatusBanner />
        <ExpandProvider store={expand}>
          <span />
        </ExpandProvider>
      </BannerProvider>
    </ClientStateProvider>,
  );
  const answerPreview = (index: number, value: DegreePreview) => act(async () => previews[index]?.answer({ ok: true, value }));
  const answerExpand = (index: number, value: ExpandResponse) => act(async () => expansions[index]?.answer({ ok: true, value }));
  return { state, banner, expand, previewStore, expansions, previews, answerPreview, answerExpand };
}

const region = () => screen.getByRole('region', { name: 'Request status' });
const snapshot = (state: ClientState) => JSON.stringify({ investigation: state.investigation.getState(), presentation: state.presentation.view.getState(), graph: state.loadedGraph() });
const start = async (r: ReturnType<typeof rig>, c: Count = count(1240), id = 'n1', overrides: Partial<DegreePreview> = {}) => {
  act(() => void r.expand.expand(ref('a', 'type-a', id), ['kind-b']));
  await r.answerPreview(r.previews.length - 1, previewOf(id, c, overrides));
};

describe('the Heavy operation banner', () => {
  it('1: stops the first page of an estimate over the threshold, shows the Heavy operation state and changes nothing', async () => {
    const r = rig();
    const before = snapshot(r.state);
    await start(r);
    expect(r.expansions).toHaveLength(0);
    const shown = region();
    expect(within(shown).getByText('Heavy operation')).toBeTruthy();
    expect(within(shown).getByText('Estimated 1,240 matches · warning threshold 500')).toBeTruthy();
    expect(within(shown).getByText('Refine filters or continue with a bounded limit of 25.')).toBeTruthy();
    expect(within(shown).getByText('Estimated matches')).toBeTruthy();
    expect(within(shown).getByRole('button', { name: 'Refine filters' })).toBeTruthy();
    expect(within(shown).getByRole('button', { name: 'Continue with 25' })).toBeTruthy();
    expect(shown.className).toContain('status-banner--warning');
    expect(snapshot(r.state)).toBe(before);
    expect(r.expand.of(n1)).toMatchObject({ status: 'idle', failure: undefined });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['click', 'enter', 'space'] as const)('2: Continue by %s sends one request with limit 25, dismisses the banner and keeps the chosen page size', async (how) => {
    const r = rig();
    await start(r);
    const button = screen.getByRole('button', { name: 'Continue with 25' });
    if (how === 'click') await userEvent.setup().click(button);
    else {
      button.focus();
      await userEvent.setup().keyboard(how === 'enter' ? '{Enter}' : ' ');
    }
    expect(r.expansions).toHaveLength(1);
    expect(r.expansions[0]?.body).toMatchObject({ sourceId: 'a', ref: { entityType: 'type-a', stableId: 'n1' }, neighborTypes: ['kind-b'], limit: 25 });
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
    await r.answerExpand(0, page('n1'));
    expect(r.state.loadedGraph().edges).toHaveLength(1);
    expect(r.expand.of(n1)).toMatchObject({ status: 'idle', chosenPageSize: undefined });
  });

  it('2: Load more works after Continue, from the cursor of the bounded page', async () => {
    const r = rig();
    await start(r);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Continue with 25' }));
    await r.answerExpand(0, { ...page('n1'), pages: [{ neighborType: 'kind-b', returned: 1, hasMore: true, nextCursor: 'c1', matchingTotal: { quality: 'unknown', scope: 'x' } }] });
    act(() => void r.expand.loadMore(n1, 'kind-b'));
    expect(r.previews).toHaveLength(1);
    expect(r.expansions[1]?.body.cursors).toEqual({ 'kind-b': 'c1' });
  });

  it('3: Continue never sends more than the chosen page size, the preview\'s default page or the page ceiling, and says the number it sends', async () => {
    const r = rig();
    r.expand.setPageSize(n1, 10);
    await start(r);
    expect(screen.getByRole('button', { name: 'Continue with 10' })).toBeTruthy();
    expect(screen.getByText('Refine filters or continue with a bounded limit of 10.')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Continue with 10' }));
    expect(r.expansions[0]?.body.limit).toBe(10);
    expect(r.expand.of(n1).chosenPageSize).toBe(10);

    const d = rig();
    await start(d, count(1240), 'n2', { pageSize: 12 });
    expect(screen.getByRole('button', { name: 'Continue with 12' })).toBeTruthy();
  });

  it('3: the page ceiling a refusal named bounds Continue', async () => {
    const r = rig();
    // a refusal that names max_page lowers the ceiling for the source
    await start(r, count(100));
    await act(async () => r.expansions[0]?.answer({ ok: false, failure: { code: 'QUERY_BUDGET_EXCEEDED', message: 'x', retryable: false, traceId: 't', details: { maxPage: 10 } } as ApiFailure }));
    await start(r, count(1240), 'n2');
    expect(screen.getByRole('button', { name: 'Continue with 10' })).toBeTruthy();
  });

  it.each([[count(500)], [count(3)], [count(undefined, 'unknown')]])('4: an estimate of 500 or less, or unknown, is sent at once and unchanged (%j)', async (c) => {
    const r = rig();
    await start(r, c);
    expect(r.expansions).toHaveLength(1);
    expect(r.expansions[0]?.body.limit).toBeUndefined();
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
  });

  it.each([
    [count(1240, 'estimated'), 'Estimated ~1,240 matches · warning threshold 500'],
    [count(1240, 'lowerBound'), 'Estimated ≥ 1,240 matches · warning threshold 500'],
    [count(500, 'lowerBound'), 'Estimated ≥ 500 matches · warning threshold 500'],
  ])('5: an inexact estimate is never worded as exact (%j)', async (c, headline) => {
    const r = rig();
    await start(r, c);
    expect(screen.getByText(headline)).toBeTruthy();
  });

  it('6: asks for the preview first when none is held, shows the node as loading meanwhile, and reads it once for two asks', async () => {
    const r = rig();
    act(() => void r.expand.expand(n1, ['kind-b']));
    expect(r.expand.of(n1).status).toBe('loading');
    act(() => void r.expand.expand(n1, ['kind-b']));
    expect(r.previews).toHaveLength(1);
    expect(r.expansions).toHaveLength(0);
    await r.answerPreview(0, previewOf('n1', count(1240)));
    expect(screen.getAllByRole('button', { name: 'Continue with 25' })).toHaveLength(1);
    expect(r.expansions).toHaveLength(0);
  });

  it('6: a held preview asks nothing', async () => {
    const r = rig();
    r.previewStore.forNode(n1, false);
    await r.answerPreview(0, previewOf('n1', count(3)));
    act(() => void r.expand.expand(n1, ['kind-b']));
    await act(async () => undefined);
    expect(r.previews).toHaveLength(1);
    expect(r.expansions).toHaveLength(1);
  });

  it('6: a preview that fails is unknown: the expand goes ahead, no banner of its own shows, and nothing is kept for the menu', async () => {
    const r = rig();
    act(() => void r.expand.expand(n1, ['kind-b']));
    await act(async () => r.previews[0]?.answer({ ok: false, failure: busy }));
    expect(r.expansions).toHaveLength(1);
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
    r.previewStore.forNode(n1, false);
    expect(r.previews).toHaveLength(2);
  });

  it('6: when the expand then fails too, its own failure shows as any expand failure does', async () => {
    const r = rig();
    act(() => void r.expand.expand(n1, ['kind-b']));
    await act(async () => r.previews[0]?.answer({ ok: false, failure: busy }));
    await act(async () => r.expansions[0]?.answer({ ok: false, failure: busy }));
    expect(within(region()).getByText('Busy')).toBeTruthy();
  });

  it('7: a continuation is not checked: Load more and Start over read no preview', async () => {
    const r = rig();
    await start(r, count(3));
    await r.answerExpand(0, { ...page('n1'), pages: [{ neighborType: 'kind-b', returned: 1, hasMore: true, nextCursor: 'c1', matchingTotal: { quality: 'unknown', scope: 'x' } }] });
    act(() => void r.expand.loadMore(n1, 'kind-b'));
    act(() => void r.expand.startOver(n1, 'kind-b'));
    expect(r.previews).toHaveLength(1);
    expect(r.expansions).toHaveLength(3);
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
  });

  it('7: a Retry of an ask that passed is not checked again, and a bounded one keeps its limit', async () => {
    const r = rig();
    await start(r, count(3));
    await act(async () => r.expansions[0]?.answer({ ok: false, failure: busy }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(r.previews).toHaveLength(1);
    expect(r.expansions).toHaveLength(2);
    expect(r.expansions[1]?.body.limit).toBeUndefined();
  });

  it('9, 10: Continue pressed twice sends one request, and a failure of it can be retried only as the bounded request', async () => {
    const r = rig();
    await start(r);
    const button = screen.getByRole('button', { name: 'Continue with 25' });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(r.expansions).toHaveLength(1);
    await act(async () => r.expansions[0]?.answer({ ok: false, failure: busy }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(r.expansions).toHaveLength(2);
    expect(r.expansions[1]?.body.limit).toBe(25);
    expect(r.previews).toHaveLength(1);
  });

  it('8: after the masking changes, Continue sends nothing', async () => {
    const r = rig();
    await start(r);
    act(() => r.state.setMask(true));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Continue with 25' }));
    expect(r.expansions).toHaveLength(0);
  });

  it('8: an ask superseded while its preview is awaited shows no banner and sends nothing; a newer ask for the node replaces the banner and Continue sends once', async () => {
    const r = rig();
    act(() => void r.expand.expand(n1, ['kind-b']));
    act(() => r.state.setMask(true));
    await r.answerPreview(0, previewOf('n1', count(1240)));
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
    expect(r.expansions).toHaveLength(0);
    act(() => r.state.setMask(false));
    const d = rig();
    await start(d);
    act(() => void d.expand.expand(n1, ['kind-b']));
    await act(async () => undefined);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Continue with 25' }));
    expect(d.expansions).toHaveLength(1);
  });

  it('11: Dismiss sends nothing and leaves the node as it was', async () => {
    const r = rig();
    await start(r);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(r.expansions).toHaveLength(0);
    expect(r.expand.of(n1).status).toBe('idle');
  });

  it('12: the banner holds no ID, and the announcement is polite', async () => {
    const r = rig();
    await start(r);
    const text = region().textContent ?? '';
    expect(text).not.toContain('n1');
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain('Heavy operation');
  });

  it('says the limit is per type when the ask names more than one type', async () => {
    const r = rig();
    act(() => void r.expand.expand(n1, ['kind-b', 'kind-c']));
    await r.answerPreview(0, { ...previewOf('n1', count(1240)), byType: [{ relationshipType: 'link-a', direction: 'out', count: count(1240), neighborTypes: ['kind-b'] }, { relationshipType: 'link-c', direction: 'out', count: count(3), neighborTypes: ['kind-c'] }] });
    expect(screen.getByText('Refine filters or continue with a bounded limit of 25 per type.')).toBeTruthy();
  });

  it('reads the preview once more, quietly, when the menu\'s own request failed earlier', async () => {
    const r = rig();
    r.previewStore.forNode(n1, false);
    await act(async () => r.previews[0]?.answer({ ok: false, failure: busy }));
    act(() => void r.expand.expand(n1, ['kind-b']));
    expect(r.previews).toHaveLength(2);
    await r.answerPreview(1, previewOf('n1', count(1240)));
    expect(screen.getByText('Estimated 1,240 matches · warning threshold 500')).toBeTruthy();
  });

  it('tells what an ask did: held, sent, or stale', async () => {
    const r = rig();
    const held = r.expand.expand(n1, ['kind-b']);
    await r.answerPreview(0, previewOf('n1', count(1240)));
    expect(await held).toBe('held');
    const sent = r.expand.expand(n2, ['kind-b']);
    await r.answerPreview(1, previewOf('n2', count(3)));
    await r.answerExpand(0, page('n2'));
    expect(await sent).toBe('sent');
    const first = r.expand.expand(n2, ['kind-b']);
    void r.expand.expand(n2, ['kind-b']);
    await act(async () => undefined);
    expect(await first).toBe('stale');
  });

  it('keeps the other node\'s ask separate', async () => {
    const r = rig();
    await start(r);
    await start(r, count(3), 'n2');
    expect(r.expansions).toHaveLength(1);
    expect(r.expansions[0]?.body.ref.stableId).toBe('n2');
  });
});
