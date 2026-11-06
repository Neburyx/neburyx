import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SearchResult } from '@neburyx/contracts';
import { renderApp } from '../test-utils.js';
import { NO_RELATED_PROPERTIES, NO_SEARCH_PROPERTIES, NOTHING_SEARCHABLE_MASKED, RELATED_MASKED, EXACT_MASKED } from './copy.js';
import { statesOf } from './states.js';
import { answerOf, hit, relatedOf, searchAt, searchKit } from './search-test-kit.js';

type Cell = 'hits' | 'empty' | 'none';

function answer(exact: Cell, related: Cell, extra: Partial<SearchResult> = {}): SearchResult {
  return answerOf('demo', exact === 'hits' ? [hit('demo', 'AC-1')] : [], {
    searchable: exact !== 'none',
    related: { ...relatedOf(related === 'hits' ? [hit('demo', 'REF-1')] : []), searchable: related !== 'none' },
    ...extra,
  });
}

describe('what the page says about the two groups together', () => {
  it.each<readonly [Cell, Cell, boolean, readonly string[]]>([
    ['hits', 'hits', false, []],
    ['hits', 'empty', false, []],
    ['hits', 'none', false, []],
    ['empty', 'hits', false, []],
    ['empty', 'empty', true, []],
    ['empty', 'none', true, [NO_RELATED_PROPERTIES]],
    ['none', 'hits', false, []],
    ['none', 'empty', true, [NO_SEARCH_PROPERTIES]],
    ['none', 'none', false, [NO_SEARCH_PROPERTIES, NO_RELATED_PROPERTIES]],
  ])('exact %s and related %s: "No matching entities" is %s and the reasons are %j', (exact, related, noMatches, reasons) => {
    expect(statesOf(answer(exact, related), false)).toEqual({ noMatches, reasons });
  });

  it.each<readonly [Cell, Cell, boolean, readonly string[]]>([
    ['hits', 'none', false, []],
    ['empty', 'none', true, [RELATED_MASKED]],
    ['none', 'empty', true, [EXACT_MASKED]],
    ['none', 'hits', false, []],
    ['none', 'none', false, [NOTHING_SEARCHABLE_MASKED]],
  ])('while masked, exact %s and related %s: "No matching entities" is %s and the reasons are %j', (exact, related, noMatches, reasons) => {
    expect(statesOf(answer(exact, related), true)).toEqual({ noMatches, reasons });
  });

  it('never reads "No matching entities" when a group failed, and still says why a group that was not searched was not', () => {
    const failed = { group: 'related' as const, code: 'QUERY_TIMEOUT' as const };
    expect(statesOf(answer('empty', 'empty', { failures: [failed] }), false).noMatches).toBe(false);
    expect(statesOf(answer('none', 'empty', { failures: [failed] }), false)).toEqual({ noMatches: false, reasons: [NO_SEARCH_PROPERTIES] });
    expect(statesOf(answer('empty', 'none', { failures: [{ group: 'exact', code: 'SOURCE_BUSY' }] }), false)).toEqual({ noMatches: false, reasons: [NO_RELATED_PROPERTIES] });
  });

  it('gives a group whose types were left out their own notes and no reason line', () => {
    const left = { entityType: 'kind-a', reason: 'index-unavailable' as const };
    expect(statesOf(answer('none', 'empty', { disabledTypes: [left] }), false)).toEqual({ noMatches: true, reasons: [] });
    expect(statesOf(answer('empty', 'none', { related: { ...relatedOf([]), searchable: false, disabledTypes: [left] } }), false)).toEqual({ noMatches: true, reasons: [] });
  });
});

describe('the states on the page', () => {
  const rendered = async (value: SearchResult, text = 'AC-1') => {
    const kit = searchKit(['demo'], async () => ({ ok: true, value }));
    renderApp(searchAt('demo', text), kit.client);
    await screen.findByRole('searchbox', { name: 'Search text' });
  };
  const main = () => screen.getByRole('main');

  it('shows "No matching entities" with the reason for the group that was not searched', async () => {
    await rendered(answer('empty', 'none'));
    expect(await screen.findByRole('heading', { level: 2, name: 'No matching entities' })).toBeDefined();
    expect(within(main()).getByText(NO_RELATED_PROPERTIES)).toBeDefined();
  });

  it('shows no reason for the group that was not searched when the other group is on the page', async () => {
    await rendered(answer('hits', 'none'));
    await screen.findByRole('heading', { level: 2, name: 'Exact ID match (1)' });
    expect(within(main()).queryByText(NO_RELATED_PROPERTIES)).toBeNull();
    expect(screen.queryByRole('heading', { level: 2, name: 'No matching entities' })).toBeNull();
  });

  it('says that nothing can be searched while personal data is masked, and not "No matching entities", when neither group was searched', async () => {
    const kit = searchKit(['demo'], async () => ({ ok: true, value: answer('none', 'none') }));
    const { state } = renderApp(searchAt('demo', 'AC-1'), kit.client);
    state.setMask(true);
    expect(await screen.findByText(NOTHING_SEARCHABLE_MASKED)).toBeDefined();
    expect(screen.queryByRole('heading', { level: 2, name: 'No matching entities' })).toBeNull();
    expect(within(main()).queryByText(/·.*s$/)).toBeNull();
  });
});
