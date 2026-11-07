import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SearchResult } from '@neburyx/contracts';
import { renderApp } from '../test-utils.js';
import { EXACT_MASKED, NO_EVIDENCE_PROPERTIES, NO_RELATED_PROPERTIES, NO_SEARCH_PROPERTIES, NOTHING_SEARCHABLE_MASKED, RELATED_MASKED } from './copy.js';
import { statesOf } from './states.js';
import { answerOf, hit, relatedOf, searchAt, searchKit } from './search-test-kit.js';

type Cell = 'hits' | 'empty' | 'none';
const CELLS: readonly Cell[] = ['hits', 'empty', 'none'];

const supports = { sourceId: 'demo', type: 'MADE_FROM', from: 'kind-a', to: 'kind-b', stableId: 'L-1' };

function answer(exact: Cell, related: Cell, evidence: Cell = 'none', extra: Partial<SearchResult> = {}): SearchResult {
  return answerOf('demo', exact === 'hits' ? [hit('demo', 'AC-1')] : [], {
    searchable: exact !== 'none',
    related: { ...relatedOf(related === 'hits' ? [hit('demo', 'REF-1')] : []), searchable: related !== 'none' },
    evidence: { hits: evidence === 'hits' ? [{ supports, records: [{ sourceRecordId: 'REC-1' }], rules: [] }] : [], count: { value: evidence === 'hits' ? 1 : 0, quality: 'exact', scope: 'search:evidence' }, searchable: evidence !== 'none', disabledRelationshipTypes: [] },
    ...extra,
  });
}

const combinations = CELLS.flatMap((exact) => CELLS.flatMap((related) => CELLS.map((evidence) => [exact, related, evidence] as const)));

describe('what the page says about the three groups together', () => {
  it.each(combinations)('exact %s, related %s, evidence %s: "No matching entities" only when a group was searched, every searched group is empty and none failed', (exact, related, evidence) => {
    const cells = [exact, related, evidence];
    const noMatches = !cells.includes('hits') && cells.includes('empty');
    expect(statesOf(answer(exact, related, evidence), false).noMatches).toBe(noMatches);
  });

  it.each(combinations)('exact %s, related %s, evidence %s: a group that was not searched says why only when no group has hits', (exact, related, evidence) => {
    const reasons = statesOf(answer(exact, related, evidence), false).reasons;
    if ([exact, related, evidence].includes('hits')) expect(reasons).toEqual([]);
    else
      expect(reasons).toEqual([...(exact === 'none' ? [NO_SEARCH_PROPERTIES] : []), ...(related === 'none' ? [NO_RELATED_PROPERTIES] : []), ...(evidence === 'none' ? [NO_EVIDENCE_PROPERTIES] : [])]);
  });

  it('never reads "No matching entities" when every group is not searched', () => {
    expect(statesOf(answer('none', 'none', 'none'), false)).toEqual({ noMatches: false, reasons: [NO_SEARCH_PROPERTIES, NO_RELATED_PROPERTIES, NO_EVIDENCE_PROPERTIES] });
  });

  it.each<readonly [Cell, Cell, Cell, boolean, readonly string[]]>([
    ['hits', 'none', 'none', false, []],
    ['empty', 'none', 'empty', true, [RELATED_MASKED]],
    ['none', 'empty', 'empty', true, [EXACT_MASKED]],
    ['none', 'hits', 'none', false, []],
    ['none', 'none', 'hits', false, []],
    ['none', 'none', 'empty', true, [EXACT_MASKED, RELATED_MASKED]],
    ['none', 'none', 'none', false, [NOTHING_SEARCHABLE_MASKED]],
  ])('while masked, exact %s, related %s, evidence %s: "No matching entities" is %s and the reasons are %j', (exact, related, evidence, noMatches, reasons) => {
    expect(statesOf(answer(exact, related, evidence), true)).toEqual({ noMatches, reasons });
  });

  it('never reads "No matching entities" when a group failed, and still says why a group that was not searched was not', () => {
    const failed = (group: 'exact' | 'related' | 'evidence') => ({ group, code: 'QUERY_TIMEOUT' as const });
    expect(statesOf(answer('empty', 'empty', 'empty', { failures: [failed('related')] }), false).noMatches).toBe(false);
    expect(statesOf(answer('empty', 'empty', 'empty', { failures: [failed('evidence')] }), false).noMatches).toBe(false);
    expect(statesOf(answer('none', 'empty', 'empty', { failures: [failed('related')] }), false)).toEqual({ noMatches: false, reasons: [NO_SEARCH_PROPERTIES] });
    expect(statesOf(answer('empty', 'none', 'empty', { failures: [failed('exact')] }), false)).toEqual({ noMatches: false, reasons: [NO_RELATED_PROPERTIES] });
    expect(statesOf(answer('empty', 'empty', 'none', { failures: [failed('exact')] }), false)).toEqual({ noMatches: false, reasons: [NO_EVIDENCE_PROPERTIES] });
  });

  it('gives a group whose types were left out their own notes and no reason line', () => {
    const left = { entityType: 'kind-a', reason: 'index-unavailable' as const };
    const leftRow = { relationshipType: 'MADE_FROM', from: 'kind-a', to: 'kind-b', reason: 'index-unavailable' as const };
    expect(statesOf(answer('none', 'empty', 'empty', { disabledTypes: [left] }), false)).toEqual({ noMatches: true, reasons: [] });
    expect(statesOf(answer('empty', 'none', 'empty', { related: { ...relatedOf([]), searchable: false, disabledTypes: [left] } }), false)).toEqual({ noMatches: true, reasons: [] });
    expect(statesOf(answer('empty', 'empty', 'none', { evidence: { hits: [], count: { value: 0, quality: 'exact', scope: 'search:evidence' }, searchable: false, disabledRelationshipTypes: [leftRow] } }), false)).toEqual({ noMatches: true, reasons: [] });
  });

  it('says the page has no group to search, and not "No matching entities", when every group is not searched or disabled', () => {
    const leftRow = { relationshipType: 'MADE_FROM', from: 'kind-a', to: 'kind-b', reason: 'no-stable-id' as const };
    const states = statesOf(answer('none', 'none', 'none', { evidence: { hits: [], count: { value: 0, quality: 'exact', scope: 'search:evidence' }, searchable: false, disabledRelationshipTypes: [leftRow] } }), false);
    expect(states.noMatches).toBe(false);
    expect(states.reasons).toEqual([NO_SEARCH_PROPERTIES, NO_RELATED_PROPERTIES]);
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
