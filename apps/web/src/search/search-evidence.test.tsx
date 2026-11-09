import { act, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { EdgeReadRef, SearchResult, StoredEdgeRef } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { createClientState } from '../state/client-state.js';
import { renderApp } from '../test-utils.js';
import { registerViewEvidence, useViewEvidence } from './evidence-action.js';
import { deferred, evidenceHit, hit, relatedOf, searchAt, searchKit, withEvidence } from './search-test-kit.js';

const main = () => screen.getByRole('main');
const GROUP = 'Evidence records · Supporting relationships (1)';

describe('the evidence group on the Search results page', () => {
  it('follows the related group with its heading and count text, one row for each hit', async () => {
    const kit = searchKit(['demo'], async () => withEvidence('demo', [hit('demo', 'AC-1')], [evidenceHit('L-1'), evidenceHit('L-2')], undefined, { related: relatedOf([hit('demo', 'REF-1')]) }));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    const headings = await screen.findAllByRole('heading', { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual(['Exact ID match (1)', 'Related records · Referenced ID (1)', 'Evidence records · Supporting relationships (2)']);
    expect(within(screen.getByRole('region', { name: 'Evidence records · Supporting relationships (2)' })).getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows in a row the mapped relationship type, the display names of its end types, the number of records and every record ID', async () => {
    const kit = searchKit(['demo'], async () => withEvidence('demo', [], [evidenceHit('L-1', { records: ['REC-1', 'DOC-9'] })]));
    renderApp(searchAt('demo', 'REC-1'), kit.client);
    const row = within(await screen.findByRole('region', { name: GROUP })).getByRole('listitem');
    expect(within(row).getByText('MADE_FROM')).toBeDefined();
    expect(within(row).getByText('KIND-A → KIND-A')).toBeDefined();
    expect(within(row).getByText('2 records: REC-1, DOC-9')).toBeDefined();
  });

  it('says one record in the singular', async () => {
    const kit = searchKit(['demo'], async () => withEvidence('demo', [], [evidenceHit('L-1', { records: ['REC-1'] })]));
    renderApp(searchAt('demo', 'REC-1'), kit.client);
    expect(await within(main()).findByText('1 record: REC-1')).toBeDefined();
  });

  it('names each rule that uses the relationship type with its version, and no rule when there is none', async () => {
    const kit = searchKit(['demo'], async () => withEvidence('demo', [], [evidenceHit('L-1', { rules: [{ ruleId: 'SD-01', ruleVersion: 1 }, { ruleId: 'SD-02', ruleVersion: 4 }] }), evidenceHit('L-2')]));
    renderApp(searchAt('demo', 'REC-1'), kit.client);
    const [first, second] = within(await screen.findByRole('region', { name: 'Evidence records · Supporting relationships (2)' })).getAllByRole('listitem');
    if (first === undefined || second === undefined) throw new Error('the group holds fewer than two rows');
    expect(within(first).getAllByText(/^Rule .* uses this relationship type$/).map((line) => line.textContent)).toEqual(['Rule SD-01 v1 uses this relationship type', 'Rule SD-02 v4 uses this relationship type']);
    expect(within(second).queryByText(/uses this relationship type/)).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Evidence records · Supporting relationships (2)' })).queryByText(/Used by rule|is used by|supports|derives/i)).toBeNull();
  });

  it('holds hits of two relationship types in the one group, each row naming its own type, and counts the rows', async () => {
    const kit = searchKit(['demo'], async () => withEvidence('demo', [], [evidenceHit('L-1', { type: 'OWNS' }), evidenceHit('L-2', { type: 'HELD_AT' })]));
    renderApp(searchAt('demo', 'REC-1'), kit.client);
    const group = await screen.findByRole('region', { name: 'Evidence records · Supporting relationships (2)' });
    expect(screen.getAllByRole('region', { name: /^Evidence records/ })).toHaveLength(1);
    expect(within(group).getByText('OWNS')).toBeDefined();
    expect(within(group).getByText('HELD_AT')).toBeDefined();
  });

  it('puts "supporting relationships" and the count with its quality label in the summary line, beside the other counts', async () => {
    const kit = searchKit(['demo'], async () => withEvidence('demo', [hit('demo', 'AC-1')], [evidenceHit('L-1')]));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    expect(await within(main()).findByText('1 exact match · 1 supporting relationship · 0.18 s')).toBeDefined();
  });

  it('shows a lower bound in the heading and the summary line', async () => {
    const many = Array.from({ length: 25 }, (_, index) => evidenceHit(`L-${index + 1}`));
    const kit = searchKit(['demo'], async () => withEvidence('demo', [hit('demo', 'AC-1')], many, { value: 25, quality: 'lowerBound', scope: 'search:evidence' }));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    expect(await screen.findByRole('heading', { level: 2, name: 'Evidence records · Supporting relationships (≥ 25 · lower bound)' })).toBeDefined();
    expect(within(main()).getByText('1 exact match · ≥ 25 supporting relationships · lower bound · 0.18 s')).toBeDefined();
  });

  it('shows the evidence group and no empty state when only evidence was found', async () => {
    const kit = searchKit(['demo'], async () => withEvidence('demo', [], [evidenceHit('L-1')]));
    renderApp(searchAt('demo', 'REC-1'), kit.client);
    expect(await screen.findByRole('region', { name: GROUP })).toBeDefined();
    expect(screen.queryByRole('heading', { level: 2, name: 'No matching entities' })).toBeNull();
    expect(screen.queryByRole('heading', { level: 2, name: /Exact ID match/ })).toBeNull();
  });
});

describe('the evidence group when it is disabled or not searched', () => {
  const disabled = (reason: 'index-unavailable' | 'index-building' | 'index-failed', searchable = false): SearchResult['evidence'] => ({
    hits: [],
    count: { value: 0, quality: 'exact', scope: 'search:evidence' },
    searchable,
    disabledRelationshipTypes: [{ relationshipType: 'MADE_FROM', from: 'kind-a', to: 'kind-a', property: 'recordId', reason }],
  });
  const withGroup = (exact: readonly string[], evidence: SearchResult['evidence'], overrides: Partial<SearchResult> = {}): ApiResult<SearchResult> =>
    withEvidence('demo', exact.map((id) => hit('demo', id)), [], undefined, { evidence, ...overrides });

  it.each([
    ['index-unavailable', 'no online index'],
    ['index-building', 'index is building'],
    ['index-failed', 'index failed'],
  ] as const)('names the property and its relationship, by its type and the display names of its ends, when its index is %s, beside the exact group', async (reason, text) => {
    const kit = searchKit(['demo'], async () => withGroup(['AC-1'], disabled(reason)));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await screen.findByRole('heading', { level: 2, name: 'Exact ID match (1)' });
    expect(within(main()).getByText(`Not searched: MADE_FROM (KIND-A → KIND-A) · recordId: ${text}`)).toBeDefined();
    expect(screen.queryByRole('heading', { level: 2, name: 'No matching entities' })).toBeNull();
  });


  it('says no relationship is configured for evidence beside "No matching entities" when the other group was searched and found nothing', async () => {
    const kit = searchKit(['demo'], async () => withGroup([], { hits: [], count: { value: 0, quality: 'exact', scope: 'search:evidence' }, searchable: false, disabledRelationshipTypes: [] }));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    expect(await screen.findByRole('heading', { level: 2, name: 'No matching entities' })).toBeDefined();
    expect(within(main()).getByText('No relationship of this source is configured for evidence records.')).toBeDefined();
  });

  it('does not read "No matching entities" when no group was searched, and says why', async () => {
    const kit = searchKit(['demo'], async () => withGroup([], disabled('index-unavailable'), { searchable: false, related: { ...relatedOf([]), searchable: false } }));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    expect(await within(main()).findByText('No property of this source is configured for search.')).toBeDefined();
    expect(screen.queryByRole('heading', { level: 2, name: 'No matching entities' })).toBeNull();
    expect(within(main()).getByText('Not searched: MADE_FROM (KIND-A → KIND-A) · recordId: no online index')).toBeDefined();
  });
});

describe('View evidence', () => {
  it('is drawn on the page, where the evidence panel host registers it, and marked link-style like the Open in graph of the other groups', async () => {
    const kit = searchKit(['demo'], async () => withEvidence('demo', [], [evidenceHit('L-1')]));
    renderApp(searchAt('demo', 'REC-1'), kit.client);
    expect((await screen.findByRole('button', { name: 'View evidence: MADE_FROM L-1' })).className).toBe('link');
  });

  it('can be reached and pressed by the keyboard, and opens the panel on the reference of the hit with one read of it', async () => {
    const asked: EdgeReadRef[] = [];
    const kit = searchKit(['demo'], async () => withEvidence('demo', [], [evidenceHit('L-1')]));
    renderApp(searchAt('demo', 'REC-1'), { ...kit.client, getEdge: async (ref) => (asked.push(ref), { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: 'View evidence: MADE_FROM L-1' });
    for (let presses = 0; document.activeElement !== button && presses < 20; presses += 1) await user.tab();
    expect(document.activeElement).toBe(button);
    await user.keyboard('{Enter}');
    expect(asked).toEqual([{ sourceId: 'demo', type: 'MADE_FROM', from: 'kind-a', to: 'kind-a', stableId: 'L-1' }]);
    expect(screen.getByRole('complementary', { name: 'Relationship evidence' })).toBeDefined();
  });
});

describe('the View evidence registration', () => {
  let unregister: (() => void) | undefined;
  afterEach(() => unregister?.());

  it('holds no action until a panel registers one, then the action, and none again once it is removed', () => {
    const { result } = renderHook(() => useViewEvidence());
    expect(result.current).toBeUndefined();
    act(() => void (unregister = registerViewEvidence(() => undefined)));
    expect(result.current).toBeTypeOf('function');
    act(() => unregister?.());
    expect(result.current).toBeUndefined();
  });

  it('stays with the registration that is current when an earlier registration of the same function is removed', () => {
    const seen: string[] = [];
    const action = (supports: StoredEdgeRef): void => void seen.push(supports.stableId);
    const { result } = renderHook(() => useViewEvidence());
    const removeEarlier = registerViewEvidence(action);
    act(() => void (unregister = registerViewEvidence(action)));
    act(() => removeEarlier());
    result.current?.({ sourceId: 'demo', type: 'T', from: 'a', to: 'b', stableId: 'L-1' });
    expect(seen).toEqual(['L-1']);
  });
});

describe('a late answer to the evidence search', () => {
  const evidenceAnswer = (sourceId: string, id: string): ApiResult<SearchResult> => withEvidence(sourceId, [], [evidenceHit(id, { sourceId })]);

  it('does not replace the answer of a newer search', async () => {
    const answers = [deferred<ApiResult<SearchResult>>(), deferred<ApiResult<SearchResult>>(), deferred<ApiResult<SearchResult>>()];
    let calls = 0;
    const kit = searchKit(['demo'], () => answers[calls++]?.promise ?? Promise.reject(new Error('no answer')));
    renderApp(searchAt('demo', 'first'), kit.client);
    await act(async () => answers[0]?.settle(evidenceAnswer('demo', 'FIRST')));
    await screen.findByText('1 record: REC-FIRST');
    const user = userEvent.setup();
    const box = () => within(main()).getByRole('searchbox', { name: 'Search text' });
    await user.clear(box());
    await user.type(box(), 'second{Enter}');
    await waitFor(() => expect(kit.searches).toHaveLength(2));
    await user.clear(box());
    await user.type(box(), 'third{Enter}');
    await waitFor(() => expect(kit.searches).toHaveLength(3));
    await act(async () => answers[2]?.settle(evidenceAnswer('demo', 'THIRD')));
    await act(async () => answers[1]?.settle(evidenceAnswer('demo', 'SECOND')));
    expect(await screen.findByText('1 record: REC-THIRD')).toBeDefined();
    expect(screen.queryByText('1 record: REC-SECOND')).toBeNull();
    expect(screen.queryByText('1 record: REC-FIRST')).toBeNull();
  });

  it('does not replace the answer of the mask now asked for', async () => {
    const earlier = deferred<ApiResult<SearchResult>>();
    const later = deferred<ApiResult<SearchResult>>();
    const answers = [earlier, later];
    let calls = 0;
    const kit = searchKit(['demo'], () => answers[calls++]?.promise ?? Promise.reject(new Error('no answer')));
    const state = createClientState();
    renderApp(searchAt('demo', 'REC-1'), kit.client, state);
    await waitFor(() => expect(kit.searches).toHaveLength(1));
    await act(async () => state.setMask(true));
    await waitFor(() => expect(kit.searches).toHaveLength(2));
    await act(async () => later.settle(evidenceAnswer('demo', 'MASKED')));
    expect(await screen.findByText('1 record: REC-MASKED')).toBeDefined();
    await act(async () => earlier.settle(evidenceAnswer('demo', 'LATE')));
    expect(screen.queryByText('1 record: REC-LATE')).toBeNull();
  });

  it('does not replace the answer of the source now selected', async () => {
    const earlier = deferred<ApiResult<SearchResult>>();
    const later = deferred<ApiResult<SearchResult>>();
    const bySource: Record<string, ReturnType<typeof deferred<ApiResult<SearchResult>>>> = { demo: earlier, other: later };
    const kit = searchKit(['demo', 'other'], (request) => bySource[request.sourceId]?.promise ?? Promise.reject(new Error('no answer')));
    renderApp(searchAt('demo', 'REC-1'), kit.client);
    await waitFor(() => expect(kit.searches).toHaveLength(1));
    const user = userEvent.setup();
    await user.selectOptions(within(main()).getByLabelText('Source'), 'other');
    await waitFor(() => expect(kit.searches.map((request) => request.sourceId)).toContain('other'));
    await act(async () => later.settle(evidenceAnswer('other', 'OTHER')));
    expect(await screen.findByText('1 record: REC-OTHER')).toBeDefined();
    await act(async () => earlier.settle(evidenceAnswer('demo', 'DEMO')));
    expect(screen.queryByText('1 record: REC-DEMO')).toBeNull();
  });
});
