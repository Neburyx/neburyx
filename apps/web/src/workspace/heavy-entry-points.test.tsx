import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Count, DegreePreview, ExpandRequest, ExpandResponse } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiResult } from '../api/client.js';
import { createExpandStore } from '../api/expand-store.js';
import { fakeClient } from '../api/fake-client.js';
import { createHeavyGuard } from '../api/heavy-guard.js';
import { createPreviewStore } from '../api/preview-store.js';
import { BannerProvider } from '../banner/banner-context.js';
import { createBuiltInBannerController } from '../banner/built-in-causes.js';
import { StatusBanner } from '../banner/status-banner.js';
import { ProfileProvider } from '../canvas/profile-context.js';
import { testProfile } from '../dev/test-profile.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { node, ref } from '../state/test-data.js';
import { staticProfile } from '../test-utils.js';
import { loadGraph, nodeKey } from './context-menu-kit.js';
import { ExpandProvider } from './expand-context.js';
import { ExpandSelectionAction } from './expand-selection-action.js';
import { createSelectionActionRegistry, SelectionActionsProvider } from './selection-actions.js';
import { SelectionBar } from './selection-bar.js';
import { answerExpand, answerPreview, count, inPanel, nodeOf, panelRig, previewOf, relation, response } from './supernode-kit.js';

afterEach(() => cleanup());

const heavyPreview = (overrides: Partial<DegreePreview> = {}) =>
  previewOf({
    byType: [
      { relationshipType: 'link-a', direction: 'out', count: count(1240, 'exact'), neighborTypes: ['kind-b'] },
      { relationshipType: 'link-z', direction: 'out', count: count(40, 'exact'), neighborTypes: ['type-c'] },
    ],
    ...overrides,
  });
const region = () => screen.getByRole('region', { name: 'Request status' });

describe('the Expand relationships panel', () => {
  it('2: Load of a heavy ask shows the banner and sends nothing; Refine filters keeps the panel open and focuses the relationship type', async () => {
    const { open, previews, expansions, state } = panelRig({ heavy: true });
    await open();
    await answerPreview(previews[0], heavyPreview());
    const user = userEvent.setup();
    await user.click(inPanel().getByRole('button', { name: 'Load 25 per type' }));
    expect(expansions).toHaveLength(0);
    expect(within(region()).getByText('Estimated 1,280 matches · warning threshold 500')).toBeTruthy();
    await user.click(within(region()).getByRole('button', { name: 'Refine filters' }));
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
    expect(expansions).toHaveLength(0);
    expect(state.presentation.view.getState().supernodePanel).toBeDefined();
    expect(document.activeElement).toBe(inPanel().getByRole('combobox', { name: 'Relationship type' }));
  });

  it('2: Refine filters keeps a panel that was opened for one type about that type', async () => {
    const { open, previews, state } = panelRig({ heavy: true });
    await open();
    act(() => state.presentation.setSupernodePanel({ key: nodeKey('n1'), neighborType: 'kind-b' }));
    await answerPreview(previews[0], heavyPreview());
    const user = userEvent.setup();
    await user.click(inPanel().getByRole('button', { name: 'Load 25 per type' }));
    await user.click(within(region()).getByRole('button', { name: 'Refine filters' }));
    expect(state.presentation.view.getState().supernodePanel).toEqual({ key: nodeKey('n1'), neighborType: 'kind-b' });
  });

  it('2: Continue sends the panel\'s ticked types with the bounded limit', async () => {
    const { open, previews, expansions } = panelRig({ heavy: true });
    await open();
    await answerPreview(previews[0], heavyPreview());
    const user = userEvent.setup();
    await user.click(inPanel().getByRole('button', { name: 'Load 25 per type' }));
    await user.click(within(region()).getByRole('button', { name: 'Continue with 25' }));
    expect(expansions[0]?.body).toMatchObject({ neighborTypes: ['kind-b', 'type-c', 'type-d'], limit: 25 });
    await answerExpand(expansions[0], response());
  });

  it('3: ticking only the lighter type loads with no warning', async () => {
    const { open, previews, expansions } = panelRig({ heavy: true });
    await open();
    await answerPreview(previews[0], heavyPreview());
    const user = userEvent.setup();
    await user.click(inPanel().getByRole('checkbox', { name: /^kind-b/ }));
    await user.click(inPanel().getByRole('button', { name: 'Load 25 per type' }));
    expect(expansions).toHaveLength(1);
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
  });

  it('3: a narrowed relationship type is judged by its own pairs', async () => {
    const { open, previews, expansions, expand } = panelRig({ heavy: true });
    await open();
    await answerPreview(previews[0], heavyPreview());
    act(() => void expand.load(ref('a', 'type-a', 'n1'), { first: ['kind-b'], more: [], relTypes: ['link-z'] }));
    await act(async () => undefined);
    expect(expansions).toHaveLength(1);
    act(() => void expand.load(ref('a', 'type-a', 'n1'), { first: ['kind-b'], more: [], relTypes: ['link-a'] }));
    await act(async () => undefined);
    expect(expansions).toHaveLength(1);
    expect(region().textContent).toContain('Estimated 1,240 matches');
  });
});

describe('one type and the keyboard', () => {
  it('5: a panel ask for one lighter type is judged by that type alone', async () => {
    const { open, previews, expansions } = panelRig({ heavy: true });
    await open();
    await answerPreview(previews[0], heavyPreview());
    await userEvent.setup().click(inPanel().getByRole('checkbox', { name: /^kind-b/ }));
    await userEvent.setup().click(inPanel().getByRole('checkbox', { name: /^type-d/ }));
    await userEvent.setup().click(inPanel().getByRole('button', { name: 'Load 25 per type' }));
    expect(expansions).toHaveLength(1);
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
  });

  it('6: the banner is reached by Tab and the keyboard activates Refine filters, leaving focus in the panel', async () => {
    const { open, previews } = panelRig({ heavy: true });
    await open();
    await answerPreview(previews[0], heavyPreview());
    const user = userEvent.setup();
    await user.click(inPanel().getByRole('button', { name: 'Load 25 per type' }));
    const refine = within(region()).getByRole('button', { name: 'Refine filters' });
    refine.focus();
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(inPanel().getByRole('combobox', { name: 'Relationship type' }));
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe('Expand on the selection bar with a heavy node in it', () => {
  interface Ask {
    readonly body: ExpandRequest;
    readonly answer: (result: ApiResult<ExpandResponse>) => void;
  }
  const profile = testProfile('a', ['type-a', 'type-b']);

  function barred() {
    const asked: Ask[] = [];
    const sizes: Record<string, number> = { n1: 3, n2: 1240, n3: 4 };
    const client = fakeClient({
      expandNeighbors: (body) => new Promise((resolve) => void asked.push({ body, answer: resolve })),
      previewExpansion: (body) => {
        const c: Count = { value: sizes[body.ref.stableId] ?? 0, quality: 'exact', scope: 'x' };
        return Promise.resolve({ ok: true, value: { ref: { sourceId: 'a', ...body.ref }, total: c, byType: [{ relationshipType: 'link-a', direction: 'out', count: c, neighborTypes: ['type-b'] }], byNeighborType: [], warnings: [], pageSize: 25, heavyOpThreshold: 500 } });
      },
    });
    const state = createClientState();
    loadGraph(state, [node('a', 'n1'), node('a', 'n2'), node('a', 'n3')], []);
    const banner = createBuiltInBannerController();
    const previews = createPreviewStore(client, () => 'person-1');
    const store = createExpandStore(client, state, () => 'person-1', undefined, createHeavyGuard(previews, banner, state));
    const registry = createSelectionActionRegistry();
    render(
      <ClientStateProvider state={state}>
        <BannerProvider controller={banner}>
          <StatusBanner />
          <SelectionActionsProvider registry={registry}>
            <ProfileProvider store={staticProfile('a', profile)}>
              <ExpandProvider store={store}>
                <ExpandSelectionAction />
                <SelectionBar />
              </ExpandProvider>
            </ProfileProvider>
          </SelectionActionsProvider>
        </BannerProvider>
      </ClientStateProvider>,
    );
    return { asked, state, store, sizes };
  }
  const expandSelected = async (state: ReturnType<typeof barred>['state']) => {
    act(() => state.presentation.select([nodeKey('n1'), nodeKey('n2'), nodeKey('n3')]));
    await userEvent.setup().click(within(screen.getByRole('toolbar', { name: 'Selection actions' })).getByRole('button', { name: 'Expand' }));
    await act(async () => undefined);
  };
  const ok = (id: string): ApiResult<ExpandResponse> => ({ ok: true, value: { ref: ref('a', 'type-a', id), pageSize: 25, nodes: [node('a', `${id}-x`)], edges: [], pages: [], warnings: [] } });

  it('4: stops at the heavy node, says how many selected nodes are waiting, names no ID, and asks no later node', async () => {
    const { asked, state } = barred();
    await expandSelected(state);
    await act(async () => asked[0]?.answer(ok('n1')));
    expect(asked.map((ask) => ask.body.ref.stableId)).toEqual(['n1']);
    expect(region().textContent).toContain('2 selected nodes are waiting.');
    expect(region().textContent).not.toContain('n2');
  });

  it('4: Continue runs the held node at its bounded limit and then the rest of the selection as normal', async () => {
    const { asked, state } = barred();
    await expandSelected(state);
    await act(async () => asked[0]?.answer(ok('n1')));
    await userEvent.setup().click(within(region()).getByRole('button', { name: 'Continue with 25' }));
    expect(asked.map((ask) => [ask.body.ref.stableId, ask.body.limit])).toEqual([['n1', undefined], ['n2', 25]]);
    await act(async () => asked[1]?.answer(ok('n2')));
    expect(asked.map((ask) => [ask.body.ref.stableId, ask.body.limit])).toEqual([['n1', undefined], ['n2', 25], ['n3', undefined]]);
  });

  it('4: Continue lets every heavy node of the rest through at its own bounded limit, without holding again', async () => {
    const { asked, state, store, sizes } = barred();
    sizes.n3 = 2000;
    store.setPageSize(ref('a', 'type-a', 'n3'), 10);
    await expandSelected(state);
    await act(async () => asked[0]?.answer(ok('n1')));
    await userEvent.setup().click(within(region()).getByRole('button', { name: 'Continue with 25' }));
    await act(async () => asked[1]?.answer(ok('n2')));
    expect(asked.map((ask) => [ask.body.ref.stableId, ask.body.limit])).toEqual([['n1', undefined], ['n2', 25], ['n3', 10]]);
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
  });

  it('4: a failure of the Continue request stops the rest and says how many were not asked', async () => {
    const { asked, state, store } = barred();
    await expandSelected(state);
    await act(async () => asked[0]?.answer(ok('n1')));
    await userEvent.setup().click(within(region()).getByRole('button', { name: 'Continue with 25' }));
    await act(async () => asked[1]?.answer({ ok: false, failure: { code: 'QUERY_TIMEOUT', message: 'x', retryable: true, traceId: 'tr-1' } }));
    expect(asked).toHaveLength(2);
    expect(store.notes.getState()).toEqual(['1 selected node was not asked after the failure.']);
  });

  it('4: a masking change before Continue sends nothing and says how many selected nodes were not asked', async () => {
    const { asked, state, store } = barred();
    await expandSelected(state);
    await act(async () => asked[0]?.answer(ok('n1')));
    act(() => state.setMask(true));
    await userEvent.setup().click(within(region()).getByRole('button', { name: 'Continue with 25' }));
    expect(asked).toHaveLength(1);
    expect(store.notes.getState()).toEqual(['2 selected nodes were not asked because the masking changed.']);
  });

  it('4: a failure before a hold is told when the warning replaces the banner', async () => {
    const { asked, state, store } = barred();
    await expandSelected(state);
    await act(async () => asked[0]?.answer({ ok: false, failure: { code: 'QUERY_TIMEOUT', message: 'x', retryable: true, traceId: 'tr-1' } }));
    expect(asked).toHaveLength(1);
    await act(async () => undefined);
    expect(store.notes.getState()).toEqual(['1 selected node failed to expand before this one.']);
    expect(region().textContent).toContain('Heavy operation');
  });

  it('4: a newer ask for the held node takes the warning down, so a Continue that no longer matches cannot be pressed', async () => {
    const { asked, state, store } = barred();
    await expandSelected(state);
    await act(async () => asked[0]?.answer(ok('n1')));
    expect(screen.queryByRole('region', { name: 'Request status' })).not.toBeNull();
    act(() => void store.loadMore(ref('a', 'type-a', 'n2'), 'type-b'));
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
  });

  it('4: Refine filters leaves the selection as it was', async () => {
    const { asked, state } = barred();
    await expandSelected(state);
    await act(async () => asked[0]?.answer(ok('n1')));
    const before = [...state.presentation.view.getState().selection].sort();
    await userEvent.setup().click(within(region()).getByRole('button', { name: 'Refine filters' }));
    expect([...state.presentation.view.getState().selection].sort()).toEqual(before);
    expect(asked).toHaveLength(1);
  });
});
