import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ExpandRequest } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createExpandStore } from '../api/expand-store.js';
import { fakeClient } from '../api/fake-client.js';
import { createPreviewStore } from '../api/preview-store.js';
import { ProfileProvider } from '../canvas/profile-context.js';
import { testProfile } from '../dev/test-profile.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { elementKey } from '../state/keys.js';
import { ref } from '../state/test-data.js';
import { staticProfile } from '../test-utils.js';
import { loadGraph } from './context-menu-kit.js';
import { ExpandForm } from './expand-form.js';
import { ExpandProvider } from './expand-context.js';
import { PreviewProvider } from './preview-context.js';
import { answerExpand, answerPreview, count, failExpand, inPanel, nodeOf, panelRig, previewOf, response } from './supernode-kit.js';

afterEach(() => cleanup());

const rows = () => inPanel().getAllByRole('checkbox').map((row) => [row.textContent?.slice(0, 6), row.getAttribute('aria-checked')]);
const preview = previewOf({ byNeighborType: [{ entityType: 'kind-b', count: count(15, 'exact') }, { entityType: 'type-c', count: count(300, 'exact') }, { entityType: 'type-d', count: count(4, 'exact') }] });
const mapped = { entityTypes: ['type-a', 'kind-b', 'type-c', 'type-d'], relationshipTypes: ['link-a', 'link-b'] };

describe('the Expand relationships panel under the filters', () => {
  it('starts with the types the filters switched off unticked, and loads the ticked ones', async () => {
    const { open, previews, expansions, state } = panelRig();
    state.presentation.setMappedTypes(mapped);
    state.setEntityTypeOff('type-c', true);
    await open();
    await answerPreview(previews[0], preview);
    expect(rows()).toEqual([['kind-b', 'true'], ['type-c', 'false'], ['type-d', 'true']]);
    await userEvent.setup().click(inPanel().getByRole('button', { name: 'Load 25 per type' }));
    expect(expansions[0]?.body.neighborTypes).toEqual(['kind-b', 'type-d']);
  });

  it('ticks every type, so the person is never stopped, when the filters leave the node nothing', async () => {
    const { open, previews, state } = panelRig();
    state.presentation.setMappedTypes(mapped);
    state.setEntityTypeOff('kind-b', true);
    await open();
    await answerPreview(previews[0], preview);
    expect(rows().map(([, ticked]) => ticked)).toEqual(['true', 'true', 'true']);
  });

  it('ticks only the type of the aggregate node it was opened from, whatever the filters say', async () => {
    const { open, previews, state } = panelRig();
    state.presentation.setMappedTypes(mapped);
    state.setEntityTypeOff('type-c', true);
    await open();
    state.presentation.setSupernodePanel({ key: elementKey(ref('a', 'type-a', 'n1')), neighborType: 'type-c' });
    await answerPreview(previews[0], preview);
    expect(rows()).toEqual([['kind-b', 'false'], ['type-c', 'true'], ['type-d', 'false']]);
  });

  it('says how many loaded entities the filters hide after a load of a hidden type, and switches the types on from the link', async () => {
    const { open, previews, expansions, state } = panelRig();
    state.presentation.setMappedTypes(mapped);
    state.setEntityTypeOff('kind-b', true);
    await open();
    await answerPreview(previews[0], preview);
    const user = userEvent.setup();
    await user.click(inPanel().getByRole('button', { name: 'Load 25 per type' }));
    await answerExpand(expansions[0], response());
    expect(inPanel().getByText(/1 loaded entity is hidden by filters\./)).not.toBeNull();
    expect(state.loadedGraph().nodes).toHaveLength(3);
    await user.click(inPanel().getByRole('button', { name: 'Show these types' }));
    expect(state.presentation.view.getState().typeFilter.offEntityTypes.size).toBe(0);
    expect(inPanel().queryByText(/hidden by filters/)).toBeNull();
  });

  it('does not count an entity hidden by hand among those the filters hide, and says nothing of one that only it hides', async () => {
    const { open, previews, expansions, state } = panelRig();
    state.presentation.setMappedTypes(mapped);
    state.setEntityTypeOff('kind-b', true);
    await open();
    await answerPreview(previews[0], preview);
    const user = userEvent.setup();
    await user.click(inPanel().getByRole('button', { name: 'Load 25 per type' }));
    await answerExpand(expansions[0], response());
    expect(inPanel().getByText(/1 loaded entity is hidden by filters\./)).not.toBeNull();
    act(() => state.hide([elementKey(ref('a', 'kind-b', 'b1'))]));
    expect(inPanel().queryByText(/hidden by filters/)).toBeNull();
  });

  it('keeps the filters and shows Retry and the chips when the preview read fails', async () => {
    const { open, previews, state } = panelRig();
    state.presentation.setMappedTypes(mapped);
    state.setEntityTypeOff('type-c', true);
    await open();
    await act(async () => previews[0]?.answer({ ok: false, failure: { code: 'SOURCE_UNAVAILABLE', message: 'x', retryable: true, traceId: 'tr-3' } } as never));
    expect(inPanel().getByRole('button', { name: 'Retry' })).not.toBeNull();
    expect([...state.presentation.view.getState().typeFilter.offEntityTypes]).toEqual(['type-c']);
  });

  it('continues a type with the cursor and relationship types its chain was started with, whatever the filters say now', async () => {
    const { open, previews, expansions, state } = panelRig();
    state.presentation.setMappedTypes(mapped);
    await open();
    await answerPreview(previews[0], preview);
    const user = userEvent.setup();
    await user.selectOptions(inPanel().getByRole('combobox', { name: 'Relationship type' }), 'link-a');
    await user.click(inPanel().getByRole('button', { name: 'Load 25 per type' }));
    await answerExpand(expansions[0], response({ pages: [{ neighborType: 'kind-b', returned: 1, hasMore: true, nextCursor: 'v1.one.mac', matchingTotal: { quality: 'unknown', scope: 'x' } }] }));
    state.setEntityTypeOff('type-c', true);
    await user.click(within(screen.getByRole('region', { name: 'Node' })).getAllByRole('button', { name: /^Load 25 more:/ })[0] as HTMLElement);
    expect(expansions[1]?.body.relTypes).toEqual(['link-a']);
    expect(expansions[1]?.body.cursors).toEqual({ 'kind-b': 'v1.one.mac' });
  });

  it('keeps the loaded counts of the node card when a relationship type is switched off', async () => {
    const { open, previews, expansions, state } = panelRig();
    state.presentation.setMappedTypes(mapped);
    await open();
    await answerPreview(previews[0], previewOf({ total: count(15, 'exact'), byNeighborType: [{ entityType: 'kind-b', count: count(15, 'exact') }] }));
    await userEvent.setup().click(inPanel().getByRole('button', { name: 'Load 25 per type' }));
    await answerExpand(expansions[0], response());
    const card = within(inPanel().getByRole('region', { name: 'Node' }));
    expect(card.getAllByText('1 loaded · 14 not loaded')).toHaveLength(2);
    act(() => state.setRelationshipTypeOff('link-a', true));
    expect(state.visibleGraph().edges).toHaveLength(0);
    expect(card.getAllByText('1 loaded · 14 not loaded')).toHaveLength(2);
  });

  it('starts a type over after a refused cursor, and leaves the filters as they were', async () => {
    const { open, previews, expansions, state } = panelRig();
    state.presentation.setMappedTypes(mapped);
    state.setEntityTypeOff('type-c', true);
    await open();
    await answerPreview(previews[0], preview);
    const user = userEvent.setup();
    await user.click(inPanel().getByRole('button', { name: 'Load 25 per type' }));
    await answerExpand(expansions[0], response({ pages: [{ neighborType: 'kind-b', returned: 1, hasMore: true, nextCursor: 'v1.one.mac', matchingTotal: { quality: 'unknown', scope: 'x' } }] }));
    await user.click(inPanel().getByRole('button', { name: 'Load 25 per type' }));
    await failExpand(expansions[1], 'CURSOR_INVALIDATED');
    expect(inPanel().queryByRole('button', { name: 'Retry' })).toBeNull();
    expect([...state.presentation.view.getState().typeFilter.offEntityTypes]).toEqual(['type-c']);
  });

  it('retries the request that failed with its own types after the filters changed, and the failure leaves the filters as they were', async () => {
    const { open, previews, expansions, state } = panelRig();
    state.presentation.setMappedTypes(mapped);
    state.setEntityTypeOff('type-c', true);
    await open();
    await answerPreview(previews[0], preview);
    const user = userEvent.setup();
    await user.click(inPanel().getByRole('button', { name: 'Load 25 per type' }));
    await failExpand(expansions[0], 'QUERY_TIMEOUT');
    expect([...state.presentation.view.getState().typeFilter.offEntityTypes]).toEqual(['type-c']);
    act(() => state.presentation.resetTypeFilter());
    await user.click(inPanel().getByRole('button', { name: 'Retry' }));
    expect(expansions).toHaveLength(2);
    expect(expansions[1]?.body).toEqual(expansions[0]?.body);
    expect(expansions[1]?.body.neighborTypes).toEqual(['kind-b', 'type-d']);
  });
});

describe('the relationship type of the panel under the filters', () => {
  const rich = (() => {
    const base = testProfile('a', ['type-a', 'type-b', 'type-c']);
    const row = (type: string, from: string, to: string) => ({ type, from, to, aggregate: false, observedAt: null, filterable: [], sortable: [], evidence: [], properties: [], stableIdProperty: null });
    return { ...base, relationshipTypes: [row('link-a', 'type-a', 'type-b'), row('link-c', 'type-a', 'type-c'), row('link-d', 'type-a', 'type-b')] };
  })();

  function formRig() {
    const sent: ExpandRequest[] = [];
    const client = fakeClient({ previewExpansion: () => new Promise(() => undefined), expandNeighbors: (body) => new Promise(() => void sent.push(body)) });
    const state = createClientState();
    loadGraph(state, [nodeOf('type-a', 'n1')], []);
    state.presentation.setMappedTypes({ entityTypes: ['type-a', 'type-b', 'type-c'], relationshipTypes: ['link-a', 'link-c', 'link-d'] });
    const previews = createPreviewStore(client, () => 'person-1');
    const expand = createExpandStore(client, state, () => 'person-1');
    const mount = () =>
      render(
        <ClientStateProvider state={state}>
          <PreviewProvider store={previews}>
            <ProfileProvider store={staticProfile('a', rich)}>
              <ExpandProvider store={expand}>
                <ExpandForm node={ref('a', 'type-a', 'n1')} />
              </ExpandProvider>
            </ProfileProvider>
          </PreviewProvider>
        </ClientStateProvider>,
      );
    return { state, mount, sent };
  }
  const select = () => screen.getByRole('combobox', { name: 'Relationship type' }) as HTMLSelectElement;
  const optionTexts = () => Array.from(select().querySelectorAll('option')).map((option) => option.textContent);

  it('reads All sourced types while no relationship type is off', () => {
    formRig().mount();
    expect(select().value).toBe('');
    expect(optionTexts()).toEqual(['All sourced types', 'link-a', 'link-c', 'link-d']);
  });

  it('offers Selected in Filters when two or more are on and some are off, and chooses the one that is on when exactly one is', () => {
    const two = formRig();
    two.state.setRelationshipTypeOff('link-d', true);
    two.mount();
    expect(optionTexts()).toContain('Selected in Filters (2)');
    cleanup();
    const one = formRig();
    one.state.setRelationshipTypeOff('link-d', true);
    one.state.setRelationshipTypeOff('link-c', true);
    one.mount();
    expect(select().value).toBe('link-a');
    expect(within(select()).queryByText(/Selected in Filters/)).toBeNull();
  });

  it('loads over the relationship types the filters leave on when that choice is made', async () => {
    const { state, mount, sent } = formRig();
    state.setRelationshipTypeOff('link-d', true);
    mount();
    const user = userEvent.setup();
    await user.selectOptions(select(), 'Selected in Filters (2)');
    await user.click(screen.getByRole('button', { name: 'Load 25 per type' }));
    expect(sent[0]?.relTypes).toEqual(['link-a', 'link-c']);
  });
});
