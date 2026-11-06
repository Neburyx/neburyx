import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { GraphNode, OpenInvestigationRequest, OpenInvestigationResponse } from '@neburyx/contracts';
import { createApiClient, type ApiClient, type ApiResult, type Fetcher } from '../api/client.js';
import { INVESTIGATION_A, INVESTIGATION_B, investigationOf, knowing, openedOf } from '../investigations/test-data.js';
import { createClientState } from '../state/client-state.js';
import { me, renderApp, source } from '../test-utils.js';
import { answerOf, deferred, hit, profiled, TYPE, searchAt } from './search-test-kit.js';

const main = () => screen.getByRole('main');
const openButton = () => within(main()).getByRole('button', { name: /^Open in graph/ });

/** A client of two sources that answers each search with one hit of the searched source, and knows the investigations it is given. */
function rig(known: Parameters<typeof knowing>[0], overrides: Partial<ApiClient> = {}) {
  const base = knowing(known, {
    getSources: async () => ({ ok: true, value: { items: [source('demo'), source('other')], nextCursor: null } }),
    getProfile: async (sourceId) => ({ ok: true, value: profiled(sourceId) }),
    searchEntities: async (request) => ({ ok: true, value: answerOf(request.sourceId, [hit(request.sourceId, 'AC-1')]) }),
    ...overrides,
  });
  return base;
}

const recordOpens = (client: ApiClient, seen: OpenInvestigationRequest[], answer?: (request: OpenInvestigationRequest, signal?: AbortSignal) => Promise<ApiResult<OpenInvestigationResponse>>): ApiClient => ({
  ...client,
  openInvestigation: (request, signal) => {
    seen.push(request);
    return answer === undefined ? client.openInvestigation(request, signal) : answer(request, signal);
  },
});

const demoAccount = { investigation: investigationOf(INVESTIGATION_A, 'demo', TYPE, 'AC-1'), node: hit('demo', 'AC-1') };

describe('opening a result in the graph', () => {
  it('opens the investigation of the hit with the session mask and shows that one entity in Explore with no neighbours', async () => {
    const seen: OpenInvestigationRequest[] = [];
    const { client } = rig([demoAccount]);
    const view = renderApp(searchAt('demo', 'AC-1'), recordOpens(client, seen));
    await screen.findByRole('heading', { level: 2, name: 'Exact ID match (1)' });
    await userEvent.setup().click(openButton());
    await waitFor(() => expect(view.router.state.location.pathname).toBe(`/explore/${INVESTIGATION_A}`));
    expect(seen).toEqual([{ sourceId: 'demo', entity: { sourceId: 'demo', entityType: TYPE, stableId: 'AC-1' }, mask: false }]);
    expect(view.state.investigation.getState()).toMatchObject({ id: INVESTIGATION_A, sourceId: 'demo', nodeRefs: [{ sourceId: 'demo', entityType: TYPE, stableId: 'AC-1' }], edgeRefs: [] });
  });

  it('sends mask true when the session asks for masking, and Explore then reads nothing unmasked', async () => {
    const seen: OpenInvestigationRequest[] = [];
    const { client, calls } = rig([{ ...demoAccount, masked: hit('demo', 'AC-1', { status: 'masked' }) }]);
    const state = createClientState();
    state.setMask(true);
    const view = renderApp(searchAt('demo', 'AC-1'), recordOpens(client, seen), state);
    await screen.findByRole('heading', { level: 2, name: 'Exact ID match (1)' });
    await userEvent.setup().click(openButton());
    await waitFor(() => expect(view.router.state.location.pathname).toBe(`/explore/${INVESTIGATION_A}`));
    expect(seen[0]).toMatchObject({ mask: true });
    expect(state.holds(INVESTIGATION_A, true)).toBe(true);
    expect(state.holds(INVESTIGATION_A, false)).toBe(false);
    await waitFor(() => expect(view.state.investigation.getState().id).toBe(INVESTIGATION_A));
    expect(calls.getEntity).toEqual([]);
    expect(calls.getInvestigation).toEqual([]);
  });

  it('reads an investigation again with the mask of the session when it is held for the other mask, and never with the other', async () => {
    const reads: (boolean | undefined)[] = [];
    const { client } = rig([{ ...demoAccount, masked: hit('demo', 'AC-1', { status: 'masked' }) }], {
      getEntity: async (ref, options) => {
        reads.push(options?.mask);
        return { ok: true, value: hit(ref.sourceId, ref.stableId) };
      },
    });
    const state = createClientState();
    state.setMask(true);
    renderApp(`/explore/${INVESTIGATION_A}`, client, state);
    await waitFor(() => expect(reads).toEqual([true]));
  });

  it('opens an entity whose stable ID is made of dots, and reloads it with the shared path-segment form', async () => {
    const urls: string[] = [];
    const node = hit('demo', '..');
    const investigation = investigationOf(INVESTIGATION_A, 'demo', TYPE, '..');
    const fetcher: Fetcher = async (input, init) => {
      urls.push(`${init?.method ?? 'GET'} ${input}`);
      if (input === '/v1/me') return new Response(JSON.stringify(me()));
      if (input === '/v1/sources') return new Response(JSON.stringify({ items: [source('demo')], nextCursor: null }));
      if (input === '/v1/sources/demo/profile') return new Response(JSON.stringify(profiled('demo')));
      if (input === '/v1/search/entities') return new Response(JSON.stringify(answerOf('demo', [node])));
      if (input === '/v1/investigations') return new Response(JSON.stringify(openedOf(investigation, node)), { status: 201 });
      if (input === `/v1/investigations/${INVESTIGATION_A}`) return new Response(JSON.stringify({ investigation, draft: { version: 1, layout: { schemaVersion: 1, layout: 'force', nodes: [], edges: [], groups: [] }, queryContext: { schemaVersion: 1, loaded: { nodes: [], edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } } } }));
      if (input.startsWith('/v1/entities/')) return new Response(JSON.stringify(node));
      return new Response('{}', { status: 404 });
    };
    const first = renderApp(searchAt('demo', '..'), createApiClient(fetcher));
    await screen.findByRole('heading', { level: 2, name: 'Exact ID match (1)' });
    await userEvent.setup().click(openButton());
    await waitFor(() => expect(first.router.state.location.pathname).toBe(`/explore/${INVESTIGATION_A}`));
    first.unmount();
    renderApp(`/explore/${INVESTIGATION_A}`, createApiClient(fetcher));
    await waitFor(() => expect(urls.some((url) => url.startsWith('GET /v1/entities/'))).toBe(true));
    expect(urls.filter((url) => url.startsWith('GET /v1/entities/'))).toEqual([`GET /v1/entities/demo/${TYPE}/~..`]);
  });

  it('makes one call for two presses, disables the control and keeps the focus on it', async () => {
    const pending = deferred<ApiResult<OpenInvestigationResponse>>();
    const seen: OpenInvestigationRequest[] = [];
    const { client } = rig([demoAccount]);
    renderApp(searchAt('demo', 'AC-1'), recordOpens(client, seen, () => pending.promise));
    await screen.findByRole('heading', { level: 2, name: 'Exact ID match (1)' });
    const user = userEvent.setup();
    const button = openButton();
    button.focus();
    await user.click(button);
    await user.click(button);
    expect(seen).toHaveLength(1);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(button);
    await act(async () => pending.settle({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }));
    await waitFor(() => expect(button.getAttribute('aria-disabled')).toBe('false'));
  });

  it('shows the notice, keeps the results and lets the control work again when the open fails, and when the source is not available as it was', async () => {
    let answer: ApiResult<OpenInvestigationResponse> = { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } };
    const seen: OpenInvestigationRequest[] = [];
    const { client } = rig([demoAccount]);
    const view = renderApp(searchAt('demo', 'AC-1'), recordOpens(client, seen, async () => answer));
    await screen.findByRole('heading', { level: 2, name: 'Exact ID match (1)' });
    const user = userEvent.setup();
    await user.click(openButton());
    const notice = await screen.findByRole('group', { name: 'Opening failed' });
    expect(within(notice).getByRole('alert').textContent).toContain('NETWORK_UNAVAILABLE');
    expect(screen.getByText('Title AC-1')).toBeDefined();
    answer = { ok: true, value: { investigation: { ...investigationOf(INVESTIGATION_A, 'demo', TYPE, 'AC-1'), sourceState: 'removed' }, created: false } };
    await user.click(openButton());
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Opening failed' })).queryByRole('alert')).toBeNull());
    expect(screen.getByText(/no longer configured/)).toBeDefined();
    expect(screen.getByText('Title AC-1')).toBeDefined();
    expect(seen).toHaveLength(2);
    expect(view.router.state.location.pathname).toBe('/search');
  });

  it('shows and navigates nowhere for an open that completes after the person left the page', async () => {
    const pending = deferred<ApiResult<OpenInvestigationResponse>>();
    const { client } = rig([demoAccount]);
    const view = renderApp(searchAt('demo', 'AC-1'), recordOpens(client, [], () => pending.promise));
    await screen.findByRole('heading', { level: 2, name: 'Exact ID match (1)' });
    await userEvent.setup().click(openButton());
    await act(() => view.router.navigate('/sources'));
    await act(async () => pending.settle({ ok: true, value: openedOf(demoAccount.investigation, demoAccount.node) }));
    expect(view.router.state.location.pathname).toBe('/sources');
    expect(view.state.investigation.getState().id).toBeNull();
  });

  it('shows and navigates nowhere for an open that completes after the source of the page changed', async () => {
    const pending = deferred<ApiResult<OpenInvestigationResponse>>();
    const { client } = rig([demoAccount]);
    const view = renderApp(searchAt('demo', 'AC-1'), recordOpens(client, [], () => pending.promise));
    await screen.findByRole('heading', { level: 2, name: 'Exact ID match (1)' });
    await userEvent.setup().click(openButton());
    await act(() => view.router.navigate({ pathname: '/search', search: '?source=other' }, { state: { q: 'AC-1' } }));
    await act(async () => pending.settle({ ok: true, value: openedOf(demoAccount.investigation, demoAccount.node) }));
    expect(view.router.state.location.pathname).toBe('/search');
    expect(view.state.investigation.getState().id).toBeNull();
  });

  it('shows and navigates nowhere for an open that completes after the mask changed', async () => {
    const pending = deferred<ApiResult<OpenInvestigationResponse>>();
    const { client } = rig([demoAccount]);
    const state = createClientState();
    const view = renderApp(searchAt('demo', 'AC-1'), recordOpens(client, [], () => pending.promise), state);
    await screen.findByRole('heading', { level: 2, name: 'Exact ID match (1)' });
    await userEvent.setup().click(openButton());
    await act(async () => state.setMask(true));
    await act(async () => pending.settle({ ok: true, value: openedOf(demoAccount.investigation, demoAccount.node) }));
    expect(view.router.state.location.pathname).toBe('/search');
    expect(state.investigation.getState().id).toBeNull();
  });

  it('opens an investigation of another source without changing the one that is shown, which is set aside whole', async () => {
    const other = { investigation: investigationOf(INVESTIGATION_B, 'other', TYPE, 'AC-1'), node: hit('other', 'AC-1') };
    const { client } = rig([demoAccount, other]);
    const view = renderApp(searchAt('demo', 'AC-1'), client);
    await screen.findByRole('heading', { level: 2, name: 'Exact ID match (1)' });
    const user = userEvent.setup();
    await user.click(openButton());
    await waitFor(() => expect(view.state.investigation.getState().id).toBe(INVESTIGATION_A));
    await act(() => view.router.navigate({ pathname: '/search', search: '?source=other' }, { state: { q: 'AC-1' } }));
    await user.click(await within(main()).findByRole('button', { name: /^Open in graph/ }));
    await waitFor(() => expect(view.state.investigation.getState().id).toBe(INVESTIGATION_B));
    expect(view.state.holds(INVESTIGATION_A, false)).toBe(true);
  });
});

describe('Explore and the mask of the session', () => {
  it('reads with the mask the session has, cancels a read that a change of the mask outdates, and never shows what the other mask read', async () => {
    const first = deferred<ApiResult<GraphNode>>();
    const second = deferred<ApiResult<GraphNode>>();
    const asked: (boolean | undefined)[] = [];
    const { client } = rig([demoAccount], {
      getEntity: (_ref, options) => {
        asked.push(options?.mask);
        return asked.length === 1 ? first.promise : second.promise;
      },
    });
    const state = createClientState();
    renderApp(`/explore/${INVESTIGATION_A}`, client, state);
    await waitFor(() => expect(asked).toEqual([false]));
    await act(async () => state.setMask(true));
    await waitFor(() => expect(asked).toEqual([false, true]));
    await act(async () => first.settle({ ok: true, value: hit('demo', 'AC-1', { status: 'plain' }) }));
    expect(state.investigation.getState().id).toBeNull();
    await act(async () => second.settle({ ok: true, value: hit('demo', 'AC-1', { status: 'masked' }) }));
    await waitFor(() => expect(state.investigation.getState().id).toBe(INVESTIGATION_A));
    expect(state.holds(INVESTIGATION_A, true)).toBe(true);
    expect(state.holds(INVESTIGATION_A, false)).toBe(false);
  });
});
