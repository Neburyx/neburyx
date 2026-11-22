import { act, screen, waitFor } from '@testing-library/react';
import type { ReadRefsRequest, ReadRefsResponse } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordingClient } from '../api/recording-client.js';
import { failure } from '../patterns/patterns-kit.js';
import { createClientState } from '../state/client-state.js';
import { bindBuiltInInspector } from '../inspector/built-in-tabs.js';
import { maskSwitchOf } from '../mask/mask-switch.js';
import { elementKey } from '../state/keys.js';
import { createPanelRegistryFor } from '../workspace/panel-registry.js';
import { me, renderApp, stubFactory } from '../test-utils.js';
import { INVESTIGATION_A, INVESTIGATION_B, investigationOf, knowing, nodeOf, readOf } from './test-data.js';
import { BACK_TO_HOME, NOT_FOUND_TITLE, OPENING, TRY_AGAIN } from './messages.js';

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
      getInvestigation: async () => ({ ok: true, value: { investigation: A.investigation, draft: restored, save: { state: 'unsaved', savedAt: null } } }),
      readRefs: async (request) => ({ ok: true, value: { nodes: request.entities.map((ref) => nodeOf(ref.sourceId, ref.entityType, ref.stableId)), edges: [], missing: { entities: [], edges: [] } } }),
    });
    renderApp(`/explore/${INVESTIGATION_A}`, client, createClientState());
    expect(await screen.findByText('3 entities · 0 relationships · loaded · exact')).toBeTruthy();
    expect(screen.getByText('3 shown · more not yet retrieved')).toBeTruthy();
  });

  it('shows placeholders and the mapping-changed banner for an item the mapping no longer covers, with no error and no read for it', async () => {
    const draft = readOf(A.investigation).draft;
    const ids = [['kind-a', 'A-1'], ['gone', 'X']] as const;
    const restored = {
      ...draft,
      layout: { ...draft.layout, nodes: ids.map(([t, id]) => ({ t, id, pinned: false, hidden: false, groupId: null })) },
      queryContext: { ...draft.queryContext, loaded: { nodes: ids.map(([t, id]) => ({ t, id })), edges: [] } },
    };
    const asked: string[] = [];
    const { client } = knowing([A], {
      getInvestigation: async () => ({ ok: true, value: { investigation: A.investigation, draft: restored, unmapped: { nodes: [{ t: 'gone', id: 'X' }], edges: [] }, mappingChange: { droppedFilters: [{ name: 'ghost', reason: 'property-removed' }] } , save: { state: 'unsaved' as const, savedAt: null } } }),
      readRefs: async (request) => {
        asked.push(...request.entities.map((ref) => ref.entityType));
        return { ok: true, value: { nodes: request.entities.map((ref) => nodeOf(ref.sourceId, ref.entityType, ref.stableId)), edges: [], missing: { entities: [], edges: [] } } };
      },
    });
    renderApp(`/explore/${INVESTIGATION_A}`, client, createClientState());
    expect(await screen.findByText('The mapping changed since this view was saved.')).toBeTruthy();
    expect(screen.getAllByText(/Dropped filters: ghost \(property removed\)\./).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Items that are no longer mapped show as/).length).toBeGreaterThan(0);
    expect(screen.getByText('2 entities · 0 relationships · loaded · exact')).toBeTruthy();
    expect(asked).toEqual(['kind-a']);
    expect(screen.queryByText('Some items are no longer available.')).toBeNull();
  });

  it('reads nothing when the investigation was opened from an entity in this session', async () => {
    const { client, calls } = knowing([A]);
    const state = createClientState();
    state.show(
      { id: INVESTIGATION_A, sourceId: 'source-a', record: { title: 'kind-a A-1', caseRef: null, status: 'open' as const, readOnly: false, version: 1, save: { kind: 'unsaved' } }, resultKeys: [], nodeRefs: [], edgeRefs: [] },
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

  it.each([['removed', 'The source this investigation used is no longer configured.'], ['repointed', 'This source now points to a different database.']] as const)('shows the saved layout read-only with the banner and reads no entity, when the source is %s', async (sourceState, headline) => {
    const { client, calls } = knowing([{ ...A, investigation: { ...A.investigation, sourceState } }]);
    const state = createClientState();
    renderApp(`/explore/${INVESTIGATION_A}`, client, state);
    expect(await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 })).toBeTruthy();
    expect(screen.getByText(headline)).toBeTruthy();
    expect(screen.getAllByRole('status').some((element) => element.textContent === 'Read-only')).toBe(true);
    expect(calls.getEntity).toEqual([]);
    expect(state.investigation.getState()).toMatchObject({ id: INVESTIGATION_A, record: { readOnly: true, sourceState } });
  });

  it('names the investigation’s own stored source in the banner of a removed source, and never the source the shell has in view', async () => {
    const gone = { investigation: investigationOf(INVESTIGATION_A, 'gone-source', 'kind-a', 'A-1', { sourceState: 'removed' }), node: nodeOf('gone-source', 'kind-a', 'A-1') };
    const { client } = knowing([gone]);
    renderApp(`/explore/${INVESTIGATION_A}`, client, createClientState());
    await screen.findByText('The source this investigation used is no longer configured.');
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
    state.show({ id: INVESTIGATION_B, sourceId: 'source-b', record: { title: 'kind-a C-1', caseRef: null, status: 'open' as const, readOnly: false, version: 1, save: { kind: 'unsaved' } }, resultKeys: [], nodeRefs: [], edgeRefs: [] }, []);
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

  it('shows the view where it stands when the masking switch is turned on: one read by references with the flag and no read of the investigation', async () => {
    const asked: Array<{ readonly mask: boolean | undefined; readonly entities: number }> = [];
    const { client, calls } = knowing([A], {
      readRefs: async (request) => {
        asked.push({ mask: request.mask, entities: request.entities.length });
        return { ok: true, value: { nodes: request.entities.map((ref) => nodeOf(ref.sourceId, ref.entityType, ref.stableId)), edges: [], missing: { entities: [], edges: [] } } };
      },
    });
    const state = createClientState();
    const panels = createPanelRegistryFor(state);
    bindBuiltInInspector(state, panels);
    renderApp(`/explore/${INVESTIGATION_A}`, client, state, undefined, undefined, undefined, undefined, undefined, panels);
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    act(() => state.presentation.select([elementKey({ sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-1' })]));
    await userEvent.setup().click(await screen.findByRole('tab', { name: 'Properties' }));
    const before = { investigations: [...calls.getInvestigation], saved: state.rereading.getState() };
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Mask sensitive values' }));
    await waitFor(() => expect(asked).toEqual([{ mask: true, entities: 1 }]));
    await waitFor(() => expect(state.rereading.getState()).toBe(false));
    expect(before.saved).toBe(false);
    expect(calls.getInvestigation).toEqual(before.investigations);
    expect(state.loadedGraph().nodes).toHaveLength(1);
    expect(state.mask.getState()).toBe(true);
  });

  it.each([
    ['a failure that can be tried again', failure('RATE_LIMITED')],
    ['a failure that says it cannot', { ...failure('SOURCE_UNAVAILABLE'), retryable: false }],
    ['a read that ended without an answer', { code: 'ABORTED' as const }],
  ])('says in the page notice that the view could not be read again after %s, with Try again, and shows nothing of the view meanwhile', async (_name, broken) => {
    let fail = true;
    const { client } = knowing([A], {
      readRefs: async (request) => (fail ? { ok: false, failure: broken } : { ok: true, value: { nodes: request.entities.map((ref) => nodeOf(ref.sourceId, ref.entityType, ref.stableId)), edges: [], missing: { entities: [], edges: [] } } }),
    });
    const state = createClientState();
    renderApp(`/explore/${INVESTIGATION_A}`, client, state);
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    act(() => maskSwitchOf(state, client).turn(true));
    expect(await screen.findByRole('group', { name: 'Masking change failed' })).toBeTruthy();
    expect(state.loadedGraph().nodes).toEqual([]);
    fail = false;
    await userEvent.setup().click(screen.getByRole('button', { name: TRY_AGAIN }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Masking change failed' })).toBeNull());
    expect(state.loadedGraph().nodes).toHaveLength(1);
  });

  describe('turning the masking switch on', () => {
    const SENTINEL = 'ZQSENTINEL Ana';
    const real = { ...nodeOf('source-a', 'kind-a', 'A-1', SENTINEL), properties: [{ key: 'holder', value: SENTINEL, dataClass: 'name' as const, masked: false }] };
    const hidden = { ...nodeOf('source-a', 'kind-a', 'A-1', 'Z•••'), properties: [{ key: 'holder', value: 'Z•••', dataClass: 'name' as const, masked: true, maskedBy: 'request' as const }] };
    const KEY = elementKey({ sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-1' });
    const LOGS = ['log', 'info', 'warn', 'error', 'debug'] as const;

    const heldText = (state: ReturnType<typeof createClientState>, logged: readonly unknown[]): string =>
      JSON.stringify([state.server.getState().results, state.investigation.getState(), state.presentation.view.getState(), window.location.href, document.body.textContent, logged], (_key, value: unknown) => (value instanceof Map || value instanceof Set ? [...value] : value));

    async function mounted(readRefs: (request: ReadRefsRequest) => Promise<ApiResult<ReadRefsResponse>>) {
      const asked: Array<{ readonly name: string; readonly args: readonly unknown[] }> = [];
      const logged: unknown[] = [];
      for (const level of LOGS) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args));
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => void (open = resolve));
      let entityReads = 0;
      const { client: base } = knowing([{ ...A, node: real }], {
        readRefs,
        getEntity: async (_ref, opts) => {
          entityReads += 1;
          if (entityReads === 2) await gate;
          return { ok: true, value: opts?.mask === true ? hidden : real };
        },
      });
      const client = recordingClient(base, (name, args) => void asked.push({ name, args }));
      const state = createClientState();
      const panels = createPanelRegistryFor(state);
      bindBuiltInInspector(state, panels);
      renderApp(`/explore/${INVESTIGATION_A}`, client, state, undefined, undefined, undefined, undefined, undefined, panels);
      await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
      act(() => state.presentation.select([KEY]));
      await userEvent.setup().click(await screen.findByRole('tab', { name: 'Properties' }));
      await waitFor(() => expect(entityReads).toBeGreaterThan(0));
      asked.length = 0;
      return { state, client, asked, logged, release: () => open() };
    }

    afterEach(() => vi.restoreAllMocks());

    it('sends only the read of the references of the view, the read of the inspected entity and the one coverage count, and holds no value of the other setting, also when an old answer arrives late', async () => {
      const { state, asked, logged, release } = await mounted(async (request) => ({ ok: true, value: { nodes: request.entities.map(() => hidden), edges: [], missing: { entities: [], edges: [] } } }));
      expect(heldText(state, logged)).toContain(SENTINEL);
      await userEvent.setup().click(screen.getByRole('switch', { name: 'Mask sensitive values' }));
      await waitFor(() => expect(state.rereading.getState()).toBe(false));
      await waitFor(() => expect(asked.map((call) => call.name)).toContain('graphCoverage'));
      await act(async () => release());
      await waitFor(() => expect(screen.queryByText(SENTINEL)).toBeNull());
      const names = asked.map((call) => call.name);
      expect([...new Set(names)].sort()).toEqual(['getEntity', 'graphCoverage', 'readRefs']);
      expect(names.filter((name) => name === 'readRefs')).toHaveLength(1);
      expect(names.filter((name) => name === 'graphCoverage')).toHaveLength(1);
      expect(asked.find((call) => call.name === 'graphCoverage')?.args[0]).toMatchObject({ mask: true });
      expect(heldText(state, logged)).not.toContain(SENTINEL);
      expect(heldText(state, logged)).toContain('Z•••');
    });

    it('holds no value of the other setting when the read fails either', async () => {
      const { state, client, logged } = await mounted(async () => ({ ok: false, failure: failure('RATE_LIMITED') }));
      expect(heldText(state, logged)).toContain(SENTINEL);
      await userEvent.setup().click(screen.getByRole('switch', { name: 'Mask sensitive values' }));
      await waitFor(() => expect(maskSwitchOf(state, client).status.getState().kind).toBe('failed'));
      expect(state.rereading.getState()).toBe(true);
      expect(heldText(state, logged)).not.toContain(SENTINEL);
    });
  });
});
