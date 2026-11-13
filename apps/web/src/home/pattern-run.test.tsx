import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { INVESTIGATION_A, investigationOf, knowing, nodeOf } from '../investigations/test-data.js';
import { listOf as presetsOf } from '../patterns/patterns-kit.js';
import { createClientState } from '../state/client-state.js';
import { renderApp, source } from '../test-utils.js';

afterEach(() => cleanup());

const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1', { createdAt: '2026-11-05T10:00:00.000Z', lastEditedAt: '2026-11-05T10:05:00.000Z' }), node: nodeOf('source-a', 'kind-a', 'A-1') };

function rig(sources: readonly string[] = ['source-a']) {
  const calls: string[] = [];
  const parts = knowing([A], {
    getSources: async () => ({ ok: true, value: { items: sources.map((id) => source(id)), nextCursor: null } }),
    listTemplates: async () => (calls.push('listTemplates'), { ok: true, value: presetsOf() }),
  });
  const watched: ApiClient = {
    ...parts.client,
    openInvestigation: (request, signal) => (calls.push('openInvestigation'), parts.client.openInvestigation(request, signal)),
    getInvestigation: (id, signal) => (calls.push('getInvestigation'), parts.client.getInvestigation(id, signal)),
    getEntity: (ref, options, signal) => (calls.push('getEntity'), parts.client.getEntity(ref, options, signal)),
    searchEntities: (request, signal) => (calls.push('searchEntities'), parts.client.searchEntities(request, signal)),
    listInvestigations: (limit, signal) => (calls.push('listInvestigations'), parts.client.listInvestigations(limit, signal)),
  };
  return { client: watched, calls };
}

const panel = () => screen.getByRole('complementary', { name: 'Patterns' });
const checked = (): string[] =>
  within(panel())
    .getAllByRole('radio')
    .filter((card) => card.getAttribute('aria-checked') === 'true')
    .map((card) => card.textContent ?? '');
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 5)));

describe('Home: Run → on a pattern', () => {
  it('opens Explore on the held investigation, kept as it was, with the panel open on that preset and the opened entity as the starting entity', async () => {
    const { client } = rig();
    const state = createClientState();
    const view = renderApp('/', client, state);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'kind-a A-1' }));
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    const id = state.investigation.getState().id;
    await act(async () => view.router.navigate('/'));
    await user.click(await screen.findByRole('button', { name: 'Run Shared addresses' }));
    await screen.findByRole('complementary', { name: 'Patterns' });
    expect(view.router.state.location.pathname).toBe(`/explore/${id}`);
    expect(state.investigation.getState().id).toBe(id);
    expect(checked()).toEqual(['Shared addresses']);
    expect(within(panel()).queryByText(/to start\./)).toBeNull();
  });

  it('opens bare Explore on the source with the panel on that preset, reading and creating nothing, and with no starting entity until one is chosen', async () => {
    const { client, calls } = rig();
    const state = createClientState();
    const view = renderApp('/', client, state);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Run Connected accounts' }));
    await screen.findByRole('complementary', { name: 'Patterns' });
    expect(view.router.state.location.pathname).toBe('/explore');
    expect(state.investigation.getState()).toMatchObject({ id: null, sourceId: 'source-a', nodeRefs: [], edgeRefs: [] });
    expect(checked()).toEqual(['Connected accounts']);
    expect(within(panel()).getByText(/to start\./)).toBeTruthy();
    expect(within(panel()).getByRole('button', { name: 'Run pattern' }).hasAttribute('disabled') || within(panel()).getByRole('button', { name: 'Run pattern' }).getAttribute('aria-disabled') === 'true').toBe(true);
    expect(calls.filter((call) => call !== 'listTemplates' && call !== 'listInvestigations')).toEqual([]);
  });

  it('leaves nothing behind when bare Explore is left with nothing opened or added: no source bound, the card and Home as before', async () => {
    const { client } = rig();
    const state = createClientState();
    const view = renderApp('/', client, state);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Run Shared devices' }));
    await screen.findByRole('complementary', { name: 'Patterns' });
    await act(async () => view.router.navigate('/'));
    await settle();
    expect(state.investigation.getState()).toMatchObject({ id: null, sourceId: null });
    expect(state.presentation.view.getState().patternsOpen).toBe(false);
    expect(await screen.findByRole('button', { name: 'Run Shared devices' })).toBeTruthy();
  });

  it('keeps the source and the graph when an entity was added before leaving', async () => {
    const { client } = rig();
    const state = createClientState();
    const view = renderApp('/', client, state);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Run Shared devices' }));
    await screen.findByRole('complementary', { name: 'Patterns' });
    act(() => state.setLoaded([], [{ sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-9' }], []));
    await act(async () => view.router.navigate('/'));
    await settle();
    expect(state.investigation.getState().sourceId).toBe('source-a');
    expect(state.investigation.getState().nodeRefs).toHaveLength(1);
  });

  it('opens on the source of the card, one investigation per source: another source chosen on the card is the one Explore is bound to', async () => {
    const { client } = rig(['source-a', 'source-b']);
    const state = createClientState();
    renderApp('/', client, state);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Patterns for' }), 'source-b');
    await user.click(await screen.findByRole('button', { name: 'Run Shared devices' }));
    await waitFor(() => expect(state.investigation.getState().sourceId).toBe('source-b'));
  });
});

describe('Home: the source released when bare Explore is left', () => {
  it('is not read for by the card on the Home that follows, and a straight way from bare Explore to an investigation opens it normally', async () => {
    const asked: string[] = [];
    const parts = knowing([A], {
      getSources: async () => ({ ok: true, value: { items: [source('source-a'), source('source-b')], nextCursor: null } }),
      listTemplates: async (sourceId) => (asked.push(sourceId), { ok: true, value: presetsOf() }),
    });
    const state = createClientState();
    const view = renderApp('/', parts.client, state);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Patterns for' }), 'source-b');
    await user.click(await screen.findByRole('button', { name: 'Run Shared devices' }));
    await screen.findByRole('complementary', { name: 'Patterns' });
    asked.length = 0;
    await act(async () => view.router.navigate('/'));
    await screen.findByRole('combobox', { name: 'Patterns for' });
    await settle();
    expect(asked).toEqual([]);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Patterns for' }), 'source-a');
    await user.click(await screen.findByRole('button', { name: 'Run Shared devices' }));
    await screen.findByRole('complementary', { name: 'Patterns' });
    await act(async () => view.router.navigate(`/explore/${INVESTIGATION_A}`));
    expect(await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 })).toBeTruthy();
    await settle();
    expect(state.investigation.getState()).toMatchObject({ id: INVESTIGATION_A, sourceId: 'source-a' });
  });
});
