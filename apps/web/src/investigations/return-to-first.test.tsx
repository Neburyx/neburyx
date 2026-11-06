import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClientState, type ClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { testProfile } from '../dev/test-profile.js';
import { renderApp, stubFactory } from '../test-utils.js';
import { openedKey } from './open-flow.js';
import { INVESTIGATION_A, INVESTIGATION_B, investigationOf, knowing, nodeOf, openedOf } from './test-data.js';

const PRINCIPAL = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1', { caseRef: 'CASE-1' }), node: nodeOf('source-a', 'kind-a', 'A-1') };
const B = { investigation: investigationOf(INVESTIGATION_B, 'source-b', 'kind-a', 'C-1'), node: nodeOf('source-b', 'kind-a', 'C-1') };
const ADDED = nodeOf('source-a', 'kind-a', 'A-2');
/** The router's own record of view transitions, not the app's. */
const ROUTER_KEY = 'remix-router-transitions';
const [ONE, TWO] = [elementKey(A.node.ref), elementKey(ADDED.ref)];

afterEach(() => vi.restoreAllMocks());

function addToFirst(state: ClientState): void {
  const shown = state.investigation.getState();
  const key = { ...openedKey('source-a', PRINCIPAL, INVESTIGATION_A, false), params: 'added:A-2' };
  state.putResult(key, { sourceId: 'source-a', nodes: [ADDED], edges: [] });
  state.setLoaded([...shown.resultKeys, key], [...shown.nodeRefs, ADDED.ref], []);
}

async function leftWithWork(overrides = {}) {
  const parts = knowing([A, B], overrides);
  const state = createClientState();
  const renderer = stubFactory();
  const view = renderApp(`/explore/${INVESTIGATION_A}`, parts.client, state, undefined, renderer.create);
  await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
  act(() => {
    addToFirst(state);
    state.presentation.setPosition(ONE, { x: 10, y: 20 });
    state.presentation.setPosition(TWO, { x: 30, y: 40 });
    state.presentation.pin([TWO]);
    state.presentation.select([ONE]);
    state.presentation.setViewport({ zoom: 2, x: 3, y: 4 });
    state.presentation.setTool('pan');
    state.presentation.setPanelSize('inspector', 321);
  });
  await screen.findByText('2 entities · 0 relationships · loaded · exact');
  return { ...parts, state, view, renderer };
}

describe('returning to the first investigation after another source was opened', () => {
  it('brings it back with its title, save state, entities, positions, pins, selection and viewport as they were, by the browser’s Back and Forward, with no read of the investigation or of its entity', async () => {
    const profiles: string[] = [];
    const { view, state, calls, renderer } = await leftWithWork({
      getProfile: async (sourceId: string) => {
        profiles.push(sourceId);
        return { ok: true, value: testProfile(sourceId) };
      },
    });
    await act(async () => view.router.navigate(`/explore/${INVESTIGATION_B}`));
    await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 });
    expect(renderer.made[0]?.restores.at(-1), 'a drawing that is new has no viewport to come back to').toBeUndefined();
    const reads = JSON.stringify(calls);
    const profilesBefore = profiles.length;
    await act(async () => view.router.navigate(-1));
    expect(await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 })).toBeTruthy();
    expect(screen.getByText('CASE-1')).toBeTruthy();
    expect(screen.getByText('Unsaved')).toBeTruthy();
    expect(screen.getByText('2 entities · 0 relationships · loaded · exact')).toBeTruthy();
    const presentation = state.presentation.view.getState();
    expect(presentation.positions.get(ONE)).toEqual({ x: 10, y: 20 });
    expect(presentation.positions.get(TWO)).toEqual({ x: 30, y: 40 });
    expect([...presentation.pins]).toEqual([TWO]);
    expect([...presentation.selection]).toEqual([ONE]);
    expect(presentation.viewport).toEqual({ zoom: 2, x: 3, y: 4 });
    expect(renderer.made[0]?.restores.at(-1), 'the drawing is given the viewport to come back to').toEqual({ zoom: 2, x: 3, y: 4 });
    await act(async () => view.router.navigate(1));
    await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 });
    await act(async () => view.router.navigate(-1));
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    expect(JSON.stringify(calls)).toBe(reads);
    expect(profiles.slice(profilesBefore), 'only the profile of each source, read again as the source in view changes').toEqual(['source-a', 'source-b', 'source-a']);
  });

  it('keeps what the second investigation shows free of the first one’s entities and presentation, and keeps the viewer’s shared settings', async () => {
    const { view, state } = await leftWithWork();
    await act(async () => view.router.navigate(`/explore/${INVESTIGATION_B}`));
    await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 });
    expect(state.loadedGraph().nodes.map((node) => node.ref.stableId)).toEqual(['C-1']);
    expect(screen.getByText('1 entity · 0 relationships · loaded · exact')).toBeTruthy();
    const presentation = state.presentation.view.getState();
    expect([...presentation.positions.keys()].some((key) => key === ONE || key === TWO)).toBe(false);
    expect(presentation.pins.size).toBe(0);
    expect(presentation.selection.size).toBe(0);
    expect(presentation.viewport).toBeUndefined();
    expect(presentation.tool).toBe('pan');
    expect(presentation.panelSizes.get('inspector')).toBe(321);
    expect(state.server.get({ ...openedKey('source-a', PRINCIPAL, INVESTIGATION_A, false) })?.nodes.map((node) => node.ref.sourceId)).toEqual(['source-a']);
  });

  it('keeps the held graph when the first investigation is opened again by its case reference, and reads only what that open itself reads', async () => {
    const opened: number[] = [];
    const { calls, state, view } = await leftWithWork({
      openInvestigation: async () => {
        opened.push(opened.length + 1);
        return { ok: true, value: openedOf(A.investigation, A.node, false) };
      },
    });
    await act(async () => view.router.navigate(`/explore/${INVESTIGATION_B}`));
    await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 });
    const before = { getEntity: calls.getEntity.length, getInvestigation: calls.getInvestigation.length };
    await act(async () => view.router.navigate('/dev/open-entity'));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Source source-a' }));
    await user.type(screen.getByLabelText('Stable ID'), 'A-1');
    await user.type(screen.getByLabelText('Case reference (optional)'), 'CASE-1');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 })).toBeTruthy();
    expect(screen.getByText('An existing investigation for this case reference was opened.')).toBeTruthy();
    expect(screen.getByText('2 entities · 0 relationships · loaded · exact')).toBeTruthy();
    expect(opened).toHaveLength(1);
    expect(calls.getEntity).toHaveLength(before.getEntity);
    expect(calls.getInvestigation).toHaveLength(before.getInvestigation);
    expect(state.loadedGraph().nodes.map((node) => node.ref.stableId).sort()).toEqual(['A-1', 'A-2']);
    expect(state.presentation.view.getState().positions.get(ONE)).toEqual({ x: 10, y: 20 });
  });

  it('reads only what is opened after a reload, shows only the starting entity of the first when it is opened, and touches no browser storage', async () => {
    const reads = vi.spyOn(Storage.prototype, 'getItem');
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const { client, calls } = knowing([A, B]);
    const state = createClientState();
    const view = renderApp(`/explore/${INVESTIGATION_B}`, client, state);
    await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 });
    expect(calls).toEqual({ getInvestigation: [INVESTIGATION_B], getEntity: [1], openInvestigation: [], listInvestigations: [] });
    await act(async () => view.router.navigate(`/explore/${INVESTIGATION_A}`));
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    expect(calls.getInvestigation).toEqual([INVESTIGATION_B, INVESTIGATION_A]);
    expect(screen.getByText('1 entity · 0 relationships · loaded · exact')).toBeTruthy();
    expect(reads.mock.calls.map(([key]) => key).filter((key) => key !== ROUTER_KEY)).toEqual([]);
    expect(writes.mock.calls.map(([key]) => key).filter((key) => key !== ROUTER_KEY)).toEqual([]);
  });

  it('leaves the first investigation on screen and held as it was when the second cannot be opened', async () => {
    const { view, state } = await leftWithWork({ getInvestigation: async (id: string) => (id === INVESTIGATION_B ? { ok: false as const, failure: { code: 'NETWORK_UNAVAILABLE' as const } } : knowing([A]).client.getInvestigation(id)) });
    const shown = state.investigation.getState();
    await act(async () => view.router.navigate(`/explore/${INVESTIGATION_B}`));
    expect(await screen.findByRole('group', { name: 'Opening failed' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'kind-a A-1', level: 1 })).toBeTruthy();
    expect(state.investigation.getState()).toBe(shown);
    expect(state.loadedGraph().nodes.map((node) => node.ref.stableId).sort()).toEqual(['A-1', 'A-2']);
    expect(state.presentation.view.getState().positions.get(TWO)).toEqual({ x: 30, y: 40 });
    await waitFor(() => expect(screen.getByText('2 entities · 0 relationships · loaded · exact')).toBeTruthy());
  });
});
