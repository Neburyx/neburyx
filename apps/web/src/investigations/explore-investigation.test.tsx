import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { me, renderApp, stubFactory } from '../test-utils.js';
import { INVESTIGATION_A, INVESTIGATION_B, investigationOf, knowing, nodeOf, readOf } from './test-data.js';
import { BACK_TO_HOME, NOT_FOUND_TITLE, OPENING, SOURCE_NOT_AVAILABLE_TITLE, TRY_AGAIN } from './messages.js';

const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1', { caseRef: 'CASE-1' }), node: nodeOf('source-a', 'kind-a', 'A-1') };
const B = { investigation: investigationOf(INVESTIGATION_B, 'source-b', 'kind-a', 'C-1'), node: nodeOf('source-b', 'kind-a', 'C-1') };

describe('/explore/{id}', () => {
  it('reads the investigation and its first entity, then shows the title, the case reference, "Unsaved", one entity loaded and shown, exact, and draws that one entity', async () => {
    const { client, calls } = knowing([A]);
    const renderer = stubFactory();
    renderApp(`/explore/${INVESTIGATION_A}`, client, createClientState(), undefined, renderer.create);
    expect(await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 })).toBeTruthy();
    expect(screen.getByText('CASE-1')).toBeTruthy();
    expect(screen.getByText('Unsaved')).toBeTruthy();
    expect(screen.getByText('1 entity · 0 relationships · loaded · exact')).toBeTruthy();
    expect(screen.getByText('1 shown · more not yet retrieved')).toBeTruthy();
    await waitFor(() => expect(renderer.made[0]?.scenes.at(-1)?.entities.map((entity) => entity.id)).toHaveLength(1));
    expect(calls.getInvestigation).toEqual([INVESTIGATION_A]);
    expect(calls.getEntity).toHaveLength(1);
  });

  it('shows a restored draft with three entities loaded and says more is not yet retrieved, with no number', async () => {
    const draft = readOf(A.investigation).draft;
    const ids = ['A-1', 'A-2', 'A-3'];
    const restored = {
      ...draft,
      layout: { ...draft.layout, nodes: ids.map((id) => ({ t: 'kind-a', id, pinned: false, hidden: false, groupId: null })) },
      queryContext: { ...draft.queryContext, loaded: { nodes: ids.map((id) => ({ t: 'kind-a', id })), edges: [] } },
    };
    const { client } = knowing([A], {
      getInvestigation: async () => ({ ok: true, value: { investigation: A.investigation, draft: restored } }),
      readRefs: async (request) => ({ ok: true, value: { nodes: request.entities.map((ref) => nodeOf(ref.sourceId, ref.entityType, ref.stableId)), edges: [], missing: { entities: [], edges: [] } } }),
    });
    renderApp(`/explore/${INVESTIGATION_A}`, client, createClientState());
    expect(await screen.findByText('3 entities · 0 relationships · loaded · exact')).toBeTruthy();
    expect(screen.getByText('3 shown · more not yet retrieved')).toBeTruthy();
  });

  it('reads nothing when the investigation was opened from an entity in this session', async () => {
    const { client, calls } = knowing([A]);
    const state = createClientState();
    state.show(
      { id: INVESTIGATION_A, sourceId: 'source-a', record: { title: 'kind-a A-1', caseRef: null, save: { kind: 'unsaved' } }, resultKeys: [], nodeRefs: [], edgeRefs: [] },
      [],
    );
    renderApp(`/explore/${INVESTIGATION_A}`, client, state);
    expect(await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 })).toBeTruthy();
    expect(screen.queryByText(OPENING)).toBeNull();
    expect(calls).toEqual({ getInvestigation: [], getEntity: [], openInvestigation: [], listInvestigations: [] });
  });

  it('shows a not-found message with a link to Home, and loads nothing, for an investigation that is not the person’s', async () => {
    const { client } = knowing([]);
    const state = createClientState();
    renderApp(`/explore/${INVESTIGATION_A}`, client, state);
    expect(await screen.findByRole('heading', { name: NOT_FOUND_TITLE, level: 1 })).toBeTruthy();
    expect(screen.getByRole('link', { name: BACK_TO_HOME }).getAttribute('href')).toBe('/');
    expect(state.investigation.getState().id).toBeNull();
  });

  it.each(['removed', 'repointed'] as const)('shows that the source is not available as it was, reads no entity and loads nothing, when it is %s', async (sourceState) => {
    const { client, calls } = knowing([{ ...A, investigation: { ...A.investigation, sourceState } }]);
    const state = createClientState();
    renderApp(`/explore/${INVESTIGATION_A}`, client, state);
    expect(await screen.findByRole('heading', { name: SOURCE_NOT_AVAILABLE_TITLE, level: 1 })).toBeTruthy();
    expect(screen.getByText('Its source is no longer configured, or it now points at another database. Nothing is read from it.')).toBeTruthy();
    expect(screen.getByRole('link', { name: BACK_TO_HOME })).toBeTruthy();
    expect(calls.getEntity).toEqual([]);
    expect(state.investigation.getState().id).toBeNull();
  });

  it('names the investigation’s own stored source under the heading of the source-not-available page, and never the source the shell has in view, with no Synthetic data badge', async () => {
    const gone = { investigation: investigationOf(INVESTIGATION_A, 'gone-source', 'kind-a', 'A-1', { sourceState: 'removed' }), node: nodeOf('gone-source', 'kind-a', 'A-1') };
    const { client } = knowing([gone]);
    renderApp(`/explore/${INVESTIGATION_A}`, client, createClientState());
    await screen.findByRole('heading', { name: SOURCE_NOT_AVAILABLE_TITLE, level: 1 });
    const line = document.querySelector('.page-heading .source-note');
    expect(line?.textContent).toBe('gone-source');
    expect(screen.queryByText('Synthetic data')).toBeNull();
  });

  it('names no source under the heading of the not-found page', async () => {
    const { client } = knowing([]);
    renderApp(`/explore/${INVESTIGATION_A}`, client, createClientState());
    await screen.findByRole('heading', { name: NOT_FOUND_TITLE, level: 1 });
    expect(document.querySelector('.page-heading .source-note')).toBeNull();
    expect(screen.getByText('There is no investigation at this link among yours.')).toBeTruthy();
  });

  it('shows the failure with Try again, keeps the investigation that was on screen identified as its own, and reads again on Try again', async () => {
    let up = false;
    const { client, calls } = knowing([A, B], { getEntity: async (ref) => (up ? { ok: true, value: nodeOf(ref.sourceId, ref.entityType, ref.stableId) } : { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    const state = createClientState();
    const first = renderApp(`/explore/${INVESTIGATION_A}`, client, state);
    up = true;
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    up = false;
    await act(async () => {
      await first.router.navigate(`/explore/${INVESTIGATION_B}`);
    });
    expect(await screen.findByText('NETWORK_UNAVAILABLE')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'kind-a A-1', level: 1 })).toBeTruthy();
    expect(state.investigation.getState().id).toBe(INVESTIGATION_A);
    expect(screen.getByRole('button', { name: TRY_AGAIN }).className).toBe('secondary');
    up = true;
    await userEvent.setup().click(screen.getByRole('button', { name: TRY_AGAIN }));
    expect(await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 })).toBeTruthy();
    expect(calls.getInvestigation.filter((id) => id === INVESTIGATION_B)).toHaveLength(2);
  });

  it('shows the failure of the principal with Try again, keeps the investigation that was on screen, and goes on once the principal is read', async () => {
    let up = false;
    const { client, calls } = knowing([A, B], { getMe: async () => (up ? { ok: true, value: me() } : { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    const state = createClientState();
    state.show({ id: INVESTIGATION_B, sourceId: 'source-b', record: { title: 'kind-a C-1', caseRef: null, save: { kind: 'unsaved' } }, resultKeys: [], nodeRefs: [], edgeRefs: [] }, []);
    renderApp(`/explore/${INVESTIGATION_A}`, client, state);
    expect((await screen.findByRole('group', { name: 'Opening failed' })).textContent).toContain('NETWORK_UNAVAILABLE');
    expect(screen.queryByText(OPENING)).toBeNull();
    expect(screen.getByRole('heading', { name: 'kind-a C-1', level: 1 })).toBeTruthy();
    expect(calls.getInvestigation).toEqual([]);
    up = true;
    await userEvent.setup().click(screen.getByRole('button', { name: TRY_AGAIN }));
    expect(await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Opening failed' })).toBeNull();
    expect(calls.getInvestigation).toEqual([INVESTIGATION_A]);
  });

  it('ignores an answer that arrives after the person moved to another investigation', async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const { client } = knowing([A, B], {
      getEntity: async (ref) => {
        if (ref.stableId === 'A-1') await slow;
        return { ok: true, value: nodeOf(ref.sourceId, ref.entityType, ref.stableId) };
      },
    });
    const state = createClientState();
    const view = renderApp(`/explore/${INVESTIGATION_A}`, client, state);
    await act(async () => {
      await view.router.navigate(`/explore/${INVESTIGATION_B}`);
    });
    expect(await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 })).toBeTruthy();
    await act(async () => {
      release();
      await slow;
    });
    expect(state.investigation.getState().id).toBe(INVESTIGATION_B);
    expect(screen.getByRole('heading', { name: 'kind-a C-1', level: 1 })).toBeTruthy();
  });

  it('brings an investigation of another source back as it was left, with no read, and shows its own source', async () => {
    const { client, calls } = knowing([A, B]);
    const state = createClientState();
    const view = renderApp(`/explore/${INVESTIGATION_A}`, client, state);
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    await act(async () => {
      await view.router.navigate(`/explore/${INVESTIGATION_B}`);
    });
    await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 });
    const reads = JSON.stringify(calls);
    await act(async () => {
      await view.router.navigate(`/explore/${INVESTIGATION_A}`);
    });
    expect(await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 })).toBeTruthy();
    expect(state.investigation.getState().sourceId).toBe('source-a');
    expect(JSON.stringify(calls)).toBe(reads);
  });

  it('tells that an existing investigation was resumed when it was reached that way', async () => {
    const { client } = knowing([A]);
    const state = createClientState();
    const view = renderApp('/', client, state);
    await act(async () => {
      await view.router.navigate(`/explore/${INVESTIGATION_A}`, { state: { resumed: true } });
    });
    expect(await screen.findByText('An existing investigation for this case reference was opened.')).toBeTruthy();
  });

  it('makes the Home link and Try again reachable in the tab order, and still shows the empty workspace at /explore', async () => {
    const { client } = knowing([]);
    renderApp(`/explore/${INVESTIGATION_A}`, client, createClientState());
    const link = await screen.findByRole('link', { name: BACK_TO_HOME });
    const user = userEvent.setup();
    for (let presses = 0; presses < 12 && document.activeElement !== link; presses += 1) await user.tab();
    expect(document.activeElement).toBe(link);
  });
});

describe('/explore', () => {
  it('still shows the empty workspace with nothing loaded', async () => {
    const { client } = knowing([]);
    renderApp('/explore', client, createClientState());
    expect(await screen.findByText('0 entities · 0 relationships · loaded · exact')).toBeTruthy();
  });

  it('shows the sentence of the reason and no Try again, and nothing else of the page, when the type of the entity has no online index', async () => {
    const { client } = knowing([A], {
      getEntity: async () => ({ ok: false, failure: { code: 'SOURCE_UNAVAILABLE', message: 'A needed index is not there, so the read was not run.', retryable: false, traceId: 'tr-index', details: { reason: 'index-unavailable' } } }),
    });
    renderApp(`/explore/${INVESTIGATION_A}`, client);
    const notice = await screen.findByRole('group', { name: 'Opening failed' });
    expect(notice.textContent).toContain('A needed index is not there, so the read was not run.');
    expect(notice.textContent).toContain('tr-index');
    expect(screen.queryByRole('button', { name: TRY_AGAIN })).toBeNull();
    expect(screen.queryByText('1 entity · 0 relationships · loaded · exact')).toBeNull();
  });

  it('offers Try again beside the sentence while the index of the entity is still building', async () => {
    const { client } = knowing([A], {
      getEntity: async () => ({ ok: false, failure: { code: 'SOURCE_UNAVAILABLE', message: 'A needed index is still building, so the read is slow. Try again later.', retryable: true, traceId: 'tr-index', details: { reason: 'index-building' } } }),
    });
    renderApp(`/explore/${INVESTIGATION_A}`, client);
    const notice = await screen.findByRole('group', { name: 'Opening failed' });
    expect(notice.textContent).toContain('A needed index is still building, so the read is slow. Try again later.');
    expect(screen.getByRole('button', { name: TRY_AGAIN })).toBeTruthy();
  });
});
