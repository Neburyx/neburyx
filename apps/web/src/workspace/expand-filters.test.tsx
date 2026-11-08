import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ExpandRequest, ExpandResponse } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiResult } from '../api/client.js';
import { createExpandStore } from '../api/expand-store.js';
import type { HeavyGuard } from '../api/heavy-guard.js';
import { fakeClient } from '../api/fake-client.js';
import { ProfileProvider } from '../canvas/profile-context.js';
import { testProfile } from '../dev/test-profile.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { node, ref } from '../state/test-data.js';
import { staticProfile } from '../test-utils.js';
import { elementKey } from '../state/keys.js';
import { loadGraph } from './context-menu-kit.js';
import { ExpandProvider, expansionControlsOf, planExpansion, relTypesToSend, startUntickedTypes } from './expand-context.js';
import { ExpandSelectionAction } from './expand-selection-action.js';
import { createSelectionActionRegistry, SelectionActionsProvider } from './selection-actions.js';
import { SelectionBar } from './selection-bar.js';

afterEach(() => cleanup());

interface Ask {
  readonly body: ExpandRequest;
  readonly answer: (result: ApiResult<ExpandResponse>) => void;
}

/** type-a joins type-b by link-a and link-d, and type-c by link-c; type-b joins type-c by link-b; type-c joins itself by link-e. */
const profile = (() => {
  const base = testProfile('a', ['type-a', 'type-b', 'type-c']);
  const row = (type: string, from: string, to: string) => ({ type, from, to, aggregate: false, observedAt: null, filterable: [], evidence: [] });
  return { ...base, relationshipTypes: [row('link-a', 'type-a', 'type-b'), row('link-b', 'type-b', 'type-c'), row('link-c', 'type-a', 'type-c'), row('link-d', 'type-a', 'type-b'), row('link-e', 'type-c', 'type-c')] };
})();
const nodeOf = (type: string, id: string) => ({ ...node('a', id), ref: ref('a', type, id), display: { title: id, type } });

function rig(guard?: HeavyGuard) {
  const asked: Ask[] = [];
  const client = fakeClient({ expandNeighbors: (body) => new Promise((resolve) => void asked.push({ body, answer: resolve })) });
  const state = createClientState();
  loadGraph(state, [nodeOf('type-a', 'n1'), nodeOf('type-a', 'n2'), nodeOf('type-b', 'n3'), nodeOf('type-c', 'n4')], []);
  state.presentation.setMappedTypes({ entityTypes: ['type-a', 'type-b', 'type-c'], relationshipTypes: ['link-a', 'link-b', 'link-c', 'link-d', 'link-e'] });
  const store = createExpandStore(client, state, () => 'person-1', undefined, guard);
  const opened: string[] = [];
  const controls = expansionControlsOf(store, profile, () => state.presentation.view.getState().typeFilter, (key) => void opened.push(key));
  return { asked, state, store, controls, opened };
}

const nodeKey = (type: string, id: string): string => elementKey(ref('a', type, id));
const a = (id: string): string => nodeKey('type-a', id);

describe('the plan of an expansion under the filters', () => {
  it('asks every neighbor type and sends no relationship type while nothing is off, and says nothing', () => {
    const { state } = rig();
    expect(planExpansion(profile, state.presentation.view.getState().typeFilter, 'type-a')).toEqual({ neighborTypes: ['type-b', 'type-c'], relTypes: undefined, note: undefined });
  });

  it('leaves out an entity type that is off, and says how many neighbor types were asked', () => {
    const { state } = rig();
    state.setEntityTypeOff('type-c', true);
    expect(planExpansion(profile, state.presentation.view.getState().typeFilter, 'type-a')).toEqual({ neighborTypes: ['type-b'], relTypes: undefined, note: 'Expanded with filters: 1 of 2 neighbor types.' });
  });

  it('sends the relationship types that are on when one that joins the node is off, with the words for both', () => {
    const { state } = rig();
    state.setRelationshipTypeOff('link-d', true);
    expect(planExpansion(profile, state.presentation.view.getState().typeFilter, 'type-a')).toEqual({ neighborTypes: ['type-b', 'type-c'], relTypes: ['link-a', 'link-c'], note: 'Expanded with filters: 2 of 2 neighbor types, 2 of 3 relationship types.' });
  });

  it('drops a neighbor type that only an off relationship type joins, and never sends a relationship type that joins none of the asked', () => {
    const { state } = rig();
    state.setRelationshipTypeOff('link-c', true);
    const plan = planExpansion(profile, state.presentation.view.getState().typeFilter, 'type-a');
    expect(plan.neighborTypes).toEqual(['type-b']);
    expect(plan.relTypes).toEqual(['link-a', 'link-d']);
    expect(relTypesToSend(profile, state.presentation.view.getState().typeFilter, 'type-a', ['type-b'])).toEqual(['link-a', 'link-d']);
  });

  it('sends nothing for an off relationship type that does not join the node', () => {
    const { state } = rig();
    state.setRelationshipTypeOff('link-b', true);
    expect(planExpansion(profile, state.presentation.view.getState().typeFilter, 'type-a')).toMatchObject({ relTypes: undefined, note: undefined });
  });
});

describe('the types that start unticked in a checklist', () => {
  it('are those the filters leave out of an expansion, and none when the filters leave the entity nothing', () => {
    const { state } = rig();
    state.setRelationshipTypeOff('link-c', true);
    expect(startUntickedTypes(profile, state.presentation.view.getState().typeFilter, 'type-a', ['type-b', 'type-c'])).toEqual(['type-c']);
    state.setEntityTypeOff('type-b', true);
    expect(startUntickedTypes(profile, state.presentation.view.getState().typeFilter, 'type-a', ['type-b', 'type-c'])).toEqual([]);
  });
});

describe('expanding a node under the filters', () => {
  it('sends the neighbor types that are on and the relationship types that are on, and tells the notes line', () => {
    const { asked, state, controls, store } = rig();
    state.setEntityTypeOff('type-c', true);
    state.setRelationshipTypeOff('link-d', true);
    expect(controls.expandNode(a('n1'))).toBe('started');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.body).toMatchObject({ neighborTypes: ['type-b'], relTypes: ['link-a'], sort: 'observed' });
    expect(store.notes.getState()).toEqual(['Expanded with filters: 1 of 2 neighbor types, 1 of 3 relationship types.']);
  });

  it('keeps a request that is running as it was when the filters change, and reads the new filters for the next', () => {
    const { asked, state, controls } = rig();
    controls.expandNode(a('n1'));
    state.setEntityTypeOff('type-b', true);
    expect(asked[0]?.body.neighborTypes).toEqual(['type-b', 'type-c']);
    controls.expandNode(a('n2'));
    expect(asked.at(-1)?.body.neighborTypes).toEqual(['type-c']);
  });

  it('makes no request when the filters leave nothing, opens the panel for the node and says so', () => {
    const { asked, state, controls, store, opened } = rig();
    state.setEntityTypeOff('type-b', true);
    state.setEntityTypeOff('type-c', true);
    expect(controls.expandNode(a('n1'))).toBe('nothing-left');
    expect(asked).toHaveLength(0);
    expect(opened).toEqual([a('n1')]);
    expect(store.notes.getState()).toEqual(['Filters leave no relationship to expand for this entity. Choose types here.']);
  });
});

describe('Expand on the selection bar under the filters', () => {
  function barred(guard?: HeavyGuard) {
    const parts = rig(guard);
    const registry = createSelectionActionRegistry();
    render(
      <ClientStateProvider state={parts.state}>
        <SelectionActionsProvider registry={registry}>
          <ProfileProvider store={staticProfile('a', profile)}>
            <ExpandProvider store={parts.store}>
              <ExpandSelectionAction />
              <SelectionBar />
            </ExpandProvider>
          </ProfileProvider>
        </SelectionActionsProvider>
      </ClientStateProvider>,
    );
    return parts;
  }
  it('says one line for several entities asked (the counts of a single entity asked are in the two tests below)', async () => {
    const { asked, state, store } = barred();
    state.setEntityTypeOff('type-c', true);
    act(() => state.presentation.select([a('n1'), a('n2')]));
    await expand();
    const timeout = (id: string) => ({ ok: false, failure: { code: 'QUERY_TIMEOUT', message: 'x', retryable: true, traceId: id } }) as const;
    await act(async () => asked[0]?.answer(timeout('tr-1')));
    await act(async () => asked[1]?.answer(timeout('tr-2')));
    expect(store.notes.getState()).toEqual(['Expanded with filters.']);
  });

  it('says the notes of the filters when the warning holds the last node asked', async () => {
    const held: unknown[] = [];
    const guard: HeavyGuard = {
      decide: async () => ({ kind: 'heavy', estimate: { value: 900, quality: 'exact' } as never, threshold: 500, pageSize: 25 }),
      hold: (hold) => void held.push(hold),
      release: () => undefined,
    };
    const { asked, state, store } = barred(guard);
    state.setEntityTypeOff('type-a', true);
    state.setRelationshipTypeOff('link-b', true);
    act(() => state.presentation.select([nodeKey('type-b', 'n3'), nodeKey('type-c', 'n4')]));
    await expand();
    await act(async () => undefined);
    expect(held).toHaveLength(1);
    expect(asked).toHaveLength(0);
    expect(store.notes.getState()).toEqual(['Expanded with filters: 1 of 3 neighbor types, 1 of 3 relationship types. 1 skipped: filters leave them nothing.']);
  });

  const expand = () => userEvent.setup().click(within(screen.getByRole('toolbar', { name: 'Selection actions' })).getByRole('button', { name: 'Expand' }));

  it('asks each node with its own types, skips the one the filters leave nothing, and counts the skipped on the notes line', async () => {
    const { asked, state, store } = barred();
    state.setEntityTypeOff('type-a', true);
    state.setRelationshipTypeOff('link-b', true);
    act(() => state.presentation.select([nodeKey('type-b', 'n3'), nodeKey('type-c', 'n4')]));
    await expand();
    expect(asked.map((ask) => [ask.body.ref.stableId, ask.body.neighborTypes, ask.body.relTypes])).toEqual([['n4', ['type-c'], ['link-e']]]);
    await act(async () => asked[0]?.answer({ ok: false, failure: { code: 'QUERY_TIMEOUT', message: 'x', retryable: true, traceId: 'tr-1' } }));
    expect(store.notes.getState()).toEqual(['Expanded with filters: 1 of 3 neighbor types, 1 of 3 relationship types. 1 skipped: filters leave them nothing.']);
  });
});
