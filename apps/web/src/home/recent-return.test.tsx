import { act, configure, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClientState, type ClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { INVESTIGATION_A, INVESTIGATION_B, investigationOf, knowing, nodeOf } from '../investigations/test-data.js';
import { openedKey } from '../investigations/open-flow.js';
import { renderApp } from '../test-utils.js';

beforeAll(() => configure({ reactStrictMode: true }));
afterAll(() => configure({ reactStrictMode: false }));

const PRINCIPAL = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1', { caseRef: 'CASE-1' }), node: nodeOf('source-a', 'kind-a', 'A-1') };
const B = { investigation: investigationOf(INVESTIGATION_B, 'source-b', 'kind-a', 'C-1'), node: nodeOf('source-b', 'kind-a', 'C-1') };
const ADDED = nodeOf('source-a', 'kind-a', 'A-2');
const TWO = elementKey(ADDED.ref);

function addToFirst(state: ClientState): void {
  const shown = state.investigation.getState();
  const key = { ...openedKey('source-a', PRINCIPAL, INVESTIGATION_A, false), params: 'added:A-2' };
  state.putResult(key, { sourceId: 'source-a', nodes: [ADDED], edges: [] });
  state.setLoaded([...shown.resultKeys, key], [...shown.nodeRefs, ADDED.ref], []);
}

const openRow = async (title: string): Promise<void> => userEvent.setup().click(await screen.findByRole('link', { name: title }));

describe('what a Recent row brings back', () => {
  it('returns an investigation with the entity added to it and its presentation, after going to Home, to another investigation and back', async () => {
    const parts = knowing([A, B]);
    const state = createClientState();
    const view = renderApp('/', parts.client, state);
    await openRow('kind-a A-1');
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    act(() => {
      addToFirst(state);
      state.presentation.setPosition(TWO, { x: 30, y: 40 });
      state.presentation.pin([TWO]);
      state.presentation.setViewport({ zoom: 2, x: 3, y: 4 });
    });
    await screen.findByText('2 entities · 0 relationships · loaded · exact');
    await act(async () => view.router.navigate(-1));
    await openRow('kind-a C-1');
    await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 });
    expect(screen.getByText('1 entity · 0 relationships · loaded · exact')).toBeTruthy();
    await act(async () => view.router.navigate(-1));
    await openRow('kind-a A-1');
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    expect(screen.getByText('2 entities · 0 relationships · loaded · exact')).toBeTruthy();
    const presentation = state.presentation.view.getState();
    expect(presentation.positions.get(TWO)).toEqual({ x: 30, y: 40 });
    expect([...presentation.pins]).toEqual([TWO]);
    expect(presentation.viewport).toEqual({ zoom: 2, x: 3, y: 4 });
  });

  it('opens the same investigation in a new session, as after a reload, with only its starting entity', async () => {
    const parts = knowing([A, B]);
    renderApp('/', parts.client, createClientState());
    await openRow('kind-a A-1');
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    expect(screen.getByText('1 entity · 0 relationships · loaded · exact')).toBeTruthy();
  });
});
