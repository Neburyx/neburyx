import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SearchResult } from '@neburyx/contracts';
import { FILTERS_COPY, NO_RELATED_PROPERTIES, NO_SEARCH_PROPERTIES } from './copy.js';
import { renderApp } from '../test-utils.js';
import { statesOf } from './states.js';
import { answerOf, FACETS_FAILURE, FAILED_FACETS, facetsOf, hit, searchAt, searchKit } from './search-test-kit.js';

const TYPES = ['kind-a', 'kind-b'] as const;
const ZERO = facetsOf({ total: 0, types: [['kind-a', 0], ['kind-b', 0]], modes: [['exact', 0], ['related', 0]] });
const SOME = facetsOf({ total: 3, types: [['kind-a', 3], ['kind-b', 0]], modes: [['exact', 3], ['related', 0]] });
const NARROWED = { entityTypes: ['kind-a'], matchModes: [] };
const answer = (overrides: Partial<SearchResult>): SearchResult => answerOf('demo', [], { searchable: true, related: { hits: [], count: { value: 0, quality: 'exact', scope: 'search:related' }, searchable: true, disabledTypes: [] }, ...overrides });
const messageOf = (overrides: Partial<SearchResult>) => statesOf(answer(overrides), false).message;

describe('what the page says when no group has a row, in order of precedence', () => {
  it('says nothing about an empty answer while a result group failed', () => {
    const failed = { failures: [{ group: 'related' as const, code: 'QUERY_TIMEOUT' as const, timeoutMs: 5000 }], related: { hits: [], count: { quality: 'unknown' as const, scope: 'search:related' }, searchable: true, disabledTypes: [] } };
    expect(messageOf({ ...failed, facets: SOME })).toBe('none');
    expect(messageOf({ ...failed, facets: ZERO, filters: NARROWED })).toBe('none');
    expect(messageOf({ ...failed, facets: ZERO })).toBe('none');
  });

  it('says "No matching entities" with nothing chosen when every searched group is empty and no count is above zero', () => {
    expect(messageOf({ facets: ZERO, filters: { entityTypes: [], matchModes: [] } })).toBe('no-matches');
  });

  it('says that matches were found and none could be shown with nothing chosen when a count is above zero', () => {
    expect(messageOf({ facets: SOME, filters: { entityTypes: [], matchModes: [] } })).toBe('unshown');
  });

  it('says "No result for this selection" with a selection when a count is above zero, and "No matching entities" when none is', () => {
    expect(messageOf({ facets: SOME, filters: NARROWED })).toBe('no-result-for-selection');
    expect(messageOf({ facets: ZERO, filters: NARROWED })).toBe('no-matches');
  });

  it('counts the evidence mode and the total as counts above zero', () => {
    expect(messageOf({ facets: facetsOf({ total: 0, modes: [['evidence', 4]] }), filters: NARROWED })).toBe('no-result-for-selection');
    expect(messageOf({ facets: facetsOf({ total: 2 }), filters: NARROWED })).toBe('no-result-for-selection');
  });

  it('treats counts that were not read as saying nothing, and a facet read that failed as no count', () => {
    expect(messageOf({ facets: FAILED_FACETS, failures: [FACETS_FAILURE], filters: NARROWED })).toBe('no-matches');
    expect(messageOf({ facets: { searchable: false }, filters: NARROWED })).toBe('no-matches');
  });

  it('says nothing about a search with no group searched, and gives the reasons', () => {
    const none = { searchable: false, related: { hits: [], count: { value: 0, quality: 'exact' as const, scope: 'search:related' }, searchable: false, disabledTypes: [] }, facets: { searchable: false as const } };
    const states = statesOf(answer(none), false);
    expect(states.message).toBe('none');
    expect(states.reasons).toContain(NO_RELATED_PROPERTIES);
  });

  it('gives no reason line for a group whose only types were not searched for their indexes: the page names each type and property instead', () => {
    const disabledTypes = [{ entityType: 'kind-a', property: 'code', reason: 'index-building' as const, typeSearched: false }];
    const states = statesOf(answer({ searchable: false, disabledTypes, facets: ZERO }), false);
    expect(states.reasons).not.toContain(NO_SEARCH_PROPERTIES);
  });

  it('does not count a group the selection hides as searched, and names it as hidden', () => {
    const hidden = answer({ searchable: false, facets: SOME, filters: { entityTypes: [], matchModes: ['related'] } });
    const states = statesOf(hidden, false);
    expect(states.hidden).toEqual(['exact', 'evidence']);
    expect(states.message).toBe('no-result-for-selection');
  });

  it('says a group has nothing to search for the selected types, apart from a group with no property at all', () => {
    const nothing = answer({ searchable: false, facets: SOME, filters: { entityTypes: ['kind-b'], matchModes: [] }, related: { hits: [], count: { value: 0, quality: 'exact', scope: 'search:related' }, searchable: false, disabledTypes: [] } });
    expect(statesOf(nothing, false).reasons).toContain(FILTERS_COPY.nothingForTypes);
    const noProperty = answer({ searchable: false, facets: facetsOf({ total: 0 }), filters: { entityTypes: ['kind-b'], matchModes: [] }, related: { hits: [], count: { value: 0, quality: 'exact', scope: 'search:related' }, searchable: false, disabledTypes: [] } });
    expect(statesOf(noProperty, false).reasons).not.toContain(FILTERS_COPY.nothingForTypes);
  });

  it('gives the selection as the reason when a type is chosen and the facet read failed, and the configuration when nothing is chosen', () => {
    const unread = { facets: FAILED_FACETS, failures: [FACETS_FAILURE], searchable: false, related: { hits: [], count: { value: 0, quality: 'exact' as const, scope: 'search:related' }, searchable: false, disabledTypes: [] } };
    expect(statesOf(answer({ ...unread, filters: { entityTypes: ['kind-b'], matchModes: [] } }), false).reasons).toContain(FILTERS_COPY.nothingForTypes);
    expect(statesOf(answer({ ...unread, filters: { entityTypes: [], matchModes: [] } }), false).reasons).not.toContain(FILTERS_COPY.nothingForTypes);
  });

  it('puts no message beside a group that has hits', () => {
    expect(statesOf(answerOf('demo', [hit('demo', 'AC-1')], { facets: SOME, filters: NARROWED }), false).message).toBe('none');
  });
});

describe('the page with those messages', () => {
  const render = async (result: SearchResult, address = '') => {
    const kit = searchKit(['demo'], async () => ({ ok: true, value: result }), { types: TYPES });
    renderApp(searchAt('demo', 'AC', address), kit.client);
    await screen.findByRole('complementary', { name: 'Filters' });
    return kit;
  };

  it('says "No result for this selection" with a Reset that clears the selection', async () => {
    const kit = await render(answer({ facets: SOME, filters: NARROWED }), '&type=kind-b');
    const empty = within(screen.getByRole('main')).getByRole('heading', { level: 2, name: 'No result for this selection' }).closest('div');
    if (empty === null) throw new Error('the message has no block');
    await userEvent.setup().click(within(empty).getByRole('button', { name: 'Reset' }));
    await screen.findByRole('complementary', { name: 'Filters' });
    expect(kit.searches.at(-1)).toEqual({ sourceId: 'demo', text: 'AC' });
  });

  it('says "Matches were found in the source but none could be shown" with nothing chosen, and no Reset', async () => {
    await render(answer({ facets: SOME, filters: { entityTypes: [], matchModes: [] } }));
    expect(within(screen.getByRole('main')).getByRole('heading', { level: 2, name: FILTERS_COPY.unshown })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
  });

  it('says "No matching entities" with a selection and no count above zero, and keeps Reset in the panel', async () => {
    await render(answer({ facets: ZERO, filters: NARROWED }), '&type=kind-a');
    expect(within(screen.getByRole('main')).getByRole('heading', { level: 2, name: 'No matching entities' })).toBeDefined();
    expect(within(screen.getByRole('complementary', { name: 'Filters' })).getByRole('button', { name: 'Reset' })).toBeDefined();
  });

  it('says that a group is hidden by the selection, apart from a group with nothing configured', async () => {
    await render(answer({ searchable: false, facets: SOME, filters: { entityTypes: [], matchModes: ['related'] } }), '&mode=related');
    expect(within(screen.getByRole('main')).getByText('Exact matches are hidden by the selection.')).toBeDefined();
    expect(within(screen.getByRole('main')).getByText('Evidence records are hidden by the selection.')).toBeDefined();
  });

  it('says that there is nothing to search for the selected types', async () => {
    await render(answer({ searchable: false, facets: SOME, filters: { entityTypes: ['kind-b'], matchModes: [] }, related: { hits: [], count: { value: 0, quality: 'exact', scope: 'search:related' }, searchable: false, disabledTypes: [] } }), '&type=kind-b');
    expect(within(screen.getByRole('main')).getAllByText(FILTERS_COPY.nothingForTypes).length).toBeGreaterThan(0);
  });
});
