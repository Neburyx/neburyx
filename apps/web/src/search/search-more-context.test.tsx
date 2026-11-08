import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { GraphNode, SearchMoreRequest, SearchMoreResult, SearchResult } from '@neburyx/contracts';
import type { ApiClient, ApiResult } from '../api/client.js';
import { renderApp } from '../test-utils.js';
import { answerOf, hit, relatedOf, searchAt, searchKit } from './search-test-kit.js';

const main = () => screen.getByRole('main');
const ok = <Value,>(value: Value): ApiResult<Value> => ({ ok: true, value });
const DROPPED = { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 };
const lowerBound = { value: 25, quality: 'lowerBound' as const, scope: 'search:related' };

const exact = hit('demo', 'AC-1');
const firstRelated = Array.from({ length: 25 }, (_, index) => hit('demo', `R-${String(index).padStart(2, '0')}`));
const first = (): SearchResult => answerOf('demo', [exact], { related: { ...relatedOf(firstRelated, lowerBound), nextCursor: 'cursor-r' } });

const relatedPage = (overrides: Record<string, unknown> = {}): SearchMoreResult =>
  ({
    sourceId: 'demo',
    group: 'related',
    hits: [{ node: hit('demo', 'R-25'), matchedProperties: [], context: { relationshipType: 'OWNS', direction: 'out', with: exact.ref } }, { node: hit('demo', 'R-26'), matchedProperties: [] }],
    count: { value: 27, quality: 'exact', scope: 'search:related' },
    dropped: DROPPED,
    warnings: [],
    ...overrides,
  }) as SearchMoreResult;

function moreKit(answer: () => ApiResult<SearchMoreResult>) {
  const kit = searchKit(['demo'], async () => ok(first()));
  const requests: SearchMoreRequest[] = [];
  const client: ApiClient = { ...kit.client, searchMore: async (request) => (requests.push(request), answer()) };
  return { client, requests };
}

const pressShowMore = async (): Promise<void> => {
  await screen.findByRole('heading', { level: 2, name: /^Related records/ });
  await userEvent.setup().click(within(main()).getByRole('button', { name: 'Show more: Related records' }));
};

describe('Show more under the related group, with relationship context', () => {
  it('sends the references of the exact matches it holds, and shows the lines of the page it adds', async () => {
    const { client, requests } = moreKit(() => ok(relatedPage()));
    renderApp(searchAt('demo', 'AC-1'), client);
    await pressShowMore();
    await waitFor(() => expect(within(main()).getByText('OWNS Title AC-1')).toBeDefined());
    expect(requests).toEqual([expect.objectContaining({ group: 'related', cursor: 'cursor-r', exactRefs: [exact.ref] })]);
    expect(main().querySelectorAll('.search-hit-relationship')).toHaveLength(1);
  });

  it('keeps the added row focused and the count as the server gave it, whatever the lines', async () => {
    const { client } = moreKit(() => ok(relatedPage()));
    renderApp(searchAt('demo', 'AC-1'), client);
    await pressShowMore();
    await screen.findByRole('heading', { level: 2, name: 'Related records · Referenced ID (27)' });
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Title R-25'));
  });

  it('sends no exactRefs for the exact or the evidence group', async () => {
    const kit = searchKit(['demo'], async () => ok(answerOf('demo', [exact], { counts: { exact: { value: 25, quality: 'lowerBound', scope: 'search:exact' } }, exactNextCursor: 'cursor-e' })));
    const requests: SearchMoreRequest[] = [];
    const client: ApiClient = { ...kit.client, searchMore: async (request) => (requests.push(request), ok({ sourceId: 'demo', group: 'exact', nodes: [], count: { value: 1, quality: 'exact', scope: 'search:exact' }, dropped: DROPPED, warnings: [] } as SearchMoreResult)) };
    renderApp(searchAt('demo', 'AC-1'), client);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Show more: Exact matches' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).not.toHaveProperty('exactRefs');
  });

  it('keeps the hits, adds them without lines, and says the relationship context was not read when the page says its read failed', async () => {
    const plain = relatedPage({ hits: [{ node: hit('demo', 'R-25'), matchedProperties: [] }], count: { value: 26, quality: 'exact', scope: 'search:related' }, contextFailure: { group: 'context', code: 'QUERY_TIMEOUT', timeoutMs: 5000 } });
    const { client } = moreKit(() => ok(plain));
    renderApp(searchAt('demo', 'AC-1'), client);
    await pressShowMore();
    await waitFor(() => expect(within(main()).getByRole('alert').textContent).toBe('Relationship context not read: the source did not answer within 5 s.'));
    expect(within(main()).getByText('Title R-25')).toBeDefined();
    expect(main().querySelectorAll('.search-hit-relationship')).toHaveLength(0);
  });

  it('names a type the page left out of the context read for want of an index', async () => {
    const left = { disabledTypes: [{ entityType: 'kind-a', property: 'id', reason: 'index-unavailable', typeSearched: false }] };
    const { client } = moreKit(() => ok(relatedPage({ context: left })));
    renderApp(searchAt('demo', 'AC-1'), client);
    await pressShowMore();
    await waitFor(() => expect(within(main()).getByText('Relationship context not read for KIND-A')).toBeDefined());
  });
});

describe('the exact matches Show more carries', () => {
  it('are at most the cap of them, in the order of the answer', async () => {
    const many: GraphNode[] = Array.from({ length: 30 }, (_, index) => hit('demo', `AC-${String(index).padStart(2, '0')}`));
    const kit = searchKit(['demo'], async () => ok(answerOf('demo', many.slice(0, 25), { related: { ...relatedOf(firstRelated, lowerBound), nextCursor: 'cursor-r' } })));
    const requests: SearchMoreRequest[] = [];
    const client: ApiClient = { ...kit.client, searchMore: async (request) => (requests.push(request), ok(relatedPage())) };
    renderApp(searchAt('demo', 'AC-'), client);
    await pressShowMore();
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.exactRefs?.map((ref) => ref.stableId)).toEqual(many.slice(0, 25).map((node) => node.ref.stableId));
  });
});
