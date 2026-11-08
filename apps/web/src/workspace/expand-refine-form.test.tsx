import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ExpandRequest, ExpandResponse } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createExpandStore } from '../api/expand-store.js';
import { fakeClient } from '../api/fake-client.js';
import { createPreviewStore } from '../api/preview-store.js';
import { ProfileProvider } from '../canvas/profile-context.js';
import { testProfile } from '../dev/test-profile.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { ref } from '../state/test-data.js';
import { staticProfile } from '../test-utils.js';
import { loadGraph } from './context-menu-kit.js';
import { ExpandForm } from './expand-form.js';
import { ExpandProvider } from './expand-context.js';
import { PreviewProvider } from './preview-context.js';
import { count, nodeOf, response } from './supernode-kit.js';

afterEach(() => cleanup());

const base = testProfile('a', ['type-a', 'type-b']);
const entity = (type: string, extra: object) => ({ ...(base.entityTypes.find((entry) => entry.type === type) ?? base.entityTypes[0] ?? fail('no entity type')), ...extra });
const profile = {
  ...base,
  entityTypes: [entity('type-a', {}), entity('type-b', { filterable: ['band', 'size', 'secret'], sortable: ['size', 'secret'], pii: ['secret'] })],
  relationshipTypes: [{ type: 'link-a', from: 'type-a', to: 'type-b', aggregate: false, observedAt: 'seenAt', filterable: ['score'], sortable: ['points'], evidence: [] }],
};

function rig() {
  const sent: ExpandRequest[] = [];
  const waiting: ((value: ApiResult<ExpandResponse>) => void)[] = [];
  const client = fakeClient({
    previewExpansion: () => new Promise(() => undefined),
    expandNeighbors: (body) => new Promise((resolve) => { sent.push(body); waiting.push((value) => resolve(value)); }),
  });
  const state = createClientState();
  loadGraph(state, [nodeOf('type-a', 'n1')], []);
  state.presentation.setMappedTypes({ entityTypes: ['type-a', 'type-b'], relationshipTypes: ['link-a'] });
  const previews = createPreviewStore(client, () => 'person-1');
  const expand = createExpandStore(client, state, () => 'person-1');
  const mount = () =>
    render(
      <ClientStateProvider state={state}>
        <PreviewProvider store={previews}>
          <ProfileProvider store={staticProfile('a', profile)}>
            <ExpandProvider store={expand}>
              <ExpandForm node={ref('a', 'type-a', 'n1')} />
            </ExpandProvider>
          </ProfileProvider>
        </PreviewProvider>
      </ClientStateProvider>,
    );
  const answer = async (value: ExpandResponse, at = waiting.length - 1): Promise<void> => {
    await act(async () => waiting[at]?.({ ok: true, value }));
  };
  const fail = async (code: string, at = waiting.length - 1): Promise<void> => {
    await act(async () => waiting[at]?.({ ok: false, failure: { code, message: 'x', retryable: true, traceId: 'tr-9' } } as never));
  };
  return { state, mount, sent, answer, fail, expand };
}

const page = (overrides: Partial<ExpandResponse['pages'][number]> = {}) => ({ neighborType: 'type-b', returned: 0, hasMore: false, matchingTotal: count(0, 'exact'), ...overrides });
const load = () => screen.getByRole('button', { name: /^Load \d+ per type$/ });
const field = (name: string) => screen.getByRole('combobox', { name });
const text = (name: string) => screen.getByRole('textbox', { name });
const optionTexts = (name: string) => Array.from(field(name).querySelectorAll('option')).map((option) => option.textContent);

const fail = (message: string): never => {
  throw new Error(message);
};

describe('Rank by', () => {
  it('lists Most recent first and the sortable properties every ticked type declares, with the order only once a property is chosen', async () => {
    rig().mount();
    expect(optionTexts('Rank by')).toEqual(['Most recent', 'TYPE-B: size', 'TYPE-B: secret', 'Relationship: points', 'Relationship: seenAt']);
    expect(screen.queryByRole('combobox', { name: 'Order' })).toBeNull();
    await userEvent.setup().selectOptions(field('Rank by'), 'relationship:points');
    expect(optionTexts('Order')).toEqual(['Highest first', 'Lowest first']);
  });

  it('asks for the rank and its order with the first page, and for none when it is Most recent', async () => {
    const { mount, sent, answer } = rig();
    mount();
    const user = userEvent.setup();
    await user.click(load());
    expect(sent[0]).not.toHaveProperty('rank');
    await answer(response({ nodes: [], edges: [], pages: [page()] }));
    await user.selectOptions(field('Rank by'), 'neighbor:size');
    await user.selectOptions(field('Order'), 'asc');
    await user.click(load());
    expect(sent[1]?.rank).toEqual({ on: 'neighbor', property: 'size', order: 'asc' });
  });

  it('leaves out personal data while masking is on, says so, and takes a rank on it off when masking is turned on', async () => {
    const { mount, state } = rig();
    mount();
    await userEvent.setup().selectOptions(field('Rank by'), 'neighbor:secret');
    await act(async () => state.setMask(true));
    expect(optionTexts('Rank by')).toEqual(['Most recent', 'TYPE-B: size', 'Relationship: points', 'Relationship: seenAt']);
    expect((field('Rank by') as HTMLSelectElement).value).toBe('observed');
    expect(screen.getByText('Personal-data properties are not offered while masking is on.')).not.toBeNull();
    expect(screen.getByText('Masking changed, so the filters and the rank on personal data were taken off.')).not.toBeNull();
  });
});

describe('Filters', () => {
  it('adds a row with the declared properties, reads its value, and sends it with the first page', async () => {
    const { mount, sent } = rig();
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add filter' }));
    expect(optionTexts('Filter 1: Property')).toEqual(['TYPE-B: band', 'TYPE-B: size', 'TYPE-B: secret', 'Relationship: score', 'Relationship: seenAt']);
    await user.type(text('Filter 1: Value'), 'high');
    await user.click(load());
    expect(sent[0]?.filters).toEqual([{ on: 'neighbor', property: 'band', op: 'eq', value: { kind: 'text', value: 'high' } }]);
  });

  it('offers is, is one of and is between, and sends a range of numbers with an open end', async () => {
    const { mount, sent } = rig();
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add filter' }));
    await user.selectOptions(field('Filter 1: Property'), 'neighbor:size');
    expect(optionTexts('Filter 1: Operator')).toEqual(['is', 'is one of', 'is between']);
    await user.selectOptions(field('Filter 1: Operator'), 'between');
    await user.type(text('Filter 1: From'), '10000');
    await user.click(load());
    expect(sent[0]?.filters).toEqual([{ on: 'neighbor', property: 'size', op: 'between', from: { kind: 'number', value: 10000 } }]);
  });

  it('says what is wrong with a value, keeps Load off until each row is whole, and sends nothing meanwhile', async () => {
    const { mount, sent } = rig();
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add filter' }));
    await user.selectOptions(field('Filter 1: Operator'), 'between');
    expect(screen.getByText('Enter a start, an end, or both.')).not.toBeNull();
    expect(screen.getByText('Fill in or remove each filter before loading.')).not.toBeNull();
    expect(load()).toHaveProperty('disabled', true);
    await user.type(text('Filter 1: From'), 'abc');
    await user.selectOptions(field('Filter 1: Kind of value'), 'number');
    expect(screen.getByText('Enter a number.')).not.toBeNull();
    await user.click(load());
    expect(sent).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Remove filter 1' }));
    expect(load()).toHaveProperty('disabled', false);
  });

  it('keeps a personal-data property out of the list while masking is on and takes a filter on it off when masking is turned on', async () => {
    const { mount, state } = rig();
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add filter' }));
    await user.selectOptions(field('Filter 1: Property'), 'neighbor:secret');
    await user.type(text('Filter 1: Value'), 'x');
    await act(async () => state.setMask(true));
    expect(screen.queryByRole('group', { name: 'Filter 1' })).toBeNull();
    expect(screen.getByText('Masking changed, so the filters and the rank on personal data were taken off.')).not.toBeNull();
  });
});

describe('a chain under filters', () => {
  it('shows the count of the first page, labelled, beside the total, and keeps it when the next page is asked', async () => {
    const { mount, sent, answer } = rig();
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add filter' }));
    await user.type(text('Filter 1: Value'), 'high');
    await user.click(load());
    await answer(response({ nodes: [], edges: [], pages: [page({ returned: 25, hasMore: true, nextCursor: 'v1.a.b', matchingTotal: count(3412, 'exact') })] }));
    expect(screen.getByText('TYPE-B: matching 3,412 · exact')).not.toBeNull();
    await user.click(load());
    expect(sent[1]?.cursors).toEqual({ 'type-b': 'v1.a.b' });
    expect(sent[1]?.filters).toEqual(sent[0]?.filters);
    await answer(response({ nodes: [], edges: [], pages: [page({ returned: 25, hasMore: true, nextCursor: 'v1.c.d', matchingTotal: count(undefined, 'unknown') })] }));
    expect(screen.getByText('TYPE-B: matching 3,412 · exact')).not.toBeNull();
  });

  it('labels a count that is not known as having no count, and never a number it was not given', async () => {
    const { mount, answer } = rig();
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add filter' }));
    await user.type(text('Filter 1: Value'), 'high');
    await user.click(load());
    await answer(response({ nodes: [], edges: [], pages: [page({ returned: 25, hasMore: true, nextCursor: 'v1.a.b', matchingTotal: count(undefined, 'unknown') })] }));
    expect(screen.getByText('TYPE-B: matching no count')).not.toBeNull();
  });

  it('starts a new chain, with no cursor, when a filter or the rank changes, and goes on with the cursor when it does not', async () => {
    const { mount, sent, answer } = rig();
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add filter' }));
    await user.type(text('Filter 1: Value'), 'high');
    await user.click(load());
    await answer(response({ nodes: [], edges: [], pages: [page({ returned: 25, hasMore: true, nextCursor: 'v1.a.b' })] }));
    await user.type(text('Filter 1: Value'), 'er');
    await user.click(load());
    expect(sent[1]).not.toHaveProperty('cursors');
    expect((sent[1]?.filters?.[0] as { value: { value: string } }).value.value).toBe('higher');
    await answer(response({ nodes: [], edges: [], pages: [page({ returned: 25, hasMore: true, nextCursor: 'v1.c.d' })] }));
    await user.selectOptions(field('Rank by'), 'neighbor:size');
    await user.click(load());
    expect(sent[2]).not.toHaveProperty('cursors');
    await answer(response({ nodes: [], edges: [], pages: [page({ returned: 25, hasMore: true, nextCursor: 'v1.e.f' })] }));
    await user.click(load());
    expect(sent[3]?.cursors).toEqual({ 'type-b': 'v1.e.f' });
  });

  it('says nothing matches, with a way to clear the filters, when a filter leaves nothing, and does not refuse another ask', async () => {
    const { mount, sent, answer } = rig();
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add filter' }));
    await user.type(text('Filter 1: Value'), 'nothing like it');
    await user.click(load());
    await answer(response({ nodes: [], edges: [], pages: [page()] }));
    expect(screen.getByText(/Nothing matches these filters\./)).not.toBeNull();
    expect(screen.getByText('TYPE-B: matching 0 · exact')).not.toBeNull();
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] ?? fail('no Clear filters'));
    expect(screen.queryByText(/Nothing matches these filters\./)).toBeNull();
    expect(screen.queryByRole('group', { name: 'Filter 1' })).toBeNull();
    await user.click(load());
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toHaveProperty('filters');
  });
});

describe('what the filters and the rank do when an ask does not go through', () => {
  const node = ref('a', 'type-a', 'n1');
  const equal = (value: string) => ({ on: 'neighbor' as const, property: 'band', op: 'eq' as const, value: { kind: 'text' as const, value } });

  it('keeps the filter and the rank in the panel when the answer fails, and asks the same again on Retry', async () => {
    const { mount, sent, fail } = rig();
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add filter' }));
    await user.type(text('Filter 1: Value'), 'high');
    await user.selectOptions(field('Rank by'), 'neighbor:size');
    await user.click(load());
    await fail('SOURCE_UNAVAILABLE');
    expect(screen.getByRole('group', { name: 'Filter 1' })).not.toBeNull();
    expect((field('Rank by') as HTMLSelectElement).value).toBe('neighbor:size');
    expect((text('Filter 1: Value') as HTMLInputElement).value).toBe('high');
    await user.click(screen.getAllByRole('button', { name: 'Retry' }).at(-1) ?? load());
    expect(sent).toHaveLength(2);
    expect(sent[1]?.filters).toEqual(sent[0]?.filters);
    expect(sent[1]?.rank).toEqual(sent[0]?.rank);
  });

  it('starts over with the filters and the rank of the chain, no cursor, and counts again, when the cursor is refused', async () => {
    const { mount, sent, answer, fail, expand } = rig();
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add filter' }));
    await user.type(text('Filter 1: Value'), 'high');
    await user.selectOptions(field('Rank by'), 'neighbor:size');
    await user.click(load());
    await answer(response({ nodes: [], edges: [], pages: [page({ returned: 25, hasMore: true, nextCursor: 'v1.a.b', matchingTotal: count(40, 'exact') })] }));
    await user.click(load());
    await fail('CURSOR_INVALIDATED');
    expect(sent[1]?.cursors).toEqual({ 'type-b': 'v1.a.b' });
    void expand.startOver(node, 'type-b');
    await act(async () => undefined);
    expect(sent).toHaveLength(3);
    expect(sent[2]).not.toHaveProperty('cursors');
    expect(sent[2]?.filters).toEqual(sent[0]?.filters);
    expect(sent[2]?.rank).toEqual(sent[0]?.rank);
    await answer(response({ nodes: [], edges: [], pages: [page({ returned: 25, hasMore: true, nextCursor: 'v1.c.d', matchingTotal: count(41, 'exact') })] }));
    expect(expand.of(node).types.get('type-b')?.matching).toMatchObject({ value: 41, quality: 'exact' });
  });

  it('drops the answer of an ask that a newer one with other filters has replaced, and keeps the chain and the count of the newer', async () => {
    const { sent, answer, expand, mount } = rig();
    mount();
    const asked = (value: string) => expand.load(node, { first: ['type-b'], more: [], relTypes: undefined, refinement: { filters: [equal(value)], rank: undefined } });
    const older = asked('low');
    const newer = asked('high');
    await act(async () => undefined);
    expect(sent.map((body) => (body.filters?.[0] as { value: { value: string } }).value.value)).toEqual(['low', 'high']);
    await answer(response({ nodes: [], edges: [], pages: [page({ returned: 25, hasMore: true, nextCursor: 'v1.n.n', matchingTotal: count(222, 'exact') })] }), 1);
    await answer(response({ nodes: [], edges: [], pages: [page({ returned: 25, hasMore: true, nextCursor: 'v1.o.o', matchingTotal: count(111, 'exact') })] }), 0);
    expect(await older).toBe('stale');
    expect(await newer).toBe('sent');
    expect(expand.of(node).types.get('type-b')?.matching).toMatchObject({ value: 222 });
    expect(expand.refinementOf(node, 'type-b')?.filters).toEqual([equal('high')]);
  });
});
