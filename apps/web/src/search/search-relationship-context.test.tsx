import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { GraphNode, RelationshipContext, SearchResult } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { renderApp } from '../test-utils.js';
import { answerOf, hit, relatedOf, searchAt, searchKit } from './search-test-kit.js';

const ok = (value: SearchResult): ApiResult<SearchResult> => ({ ok: true, value });
const main = () => screen.getByRole('main');

const exactNode = (title?: string): GraphNode => {
  const node = hit('demo', 'AC-1');
  return title === undefined ? node : { ...node, display: { ...node.display, title } };
};
const contextTo = (exact: GraphNode, relationshipType: string, direction: 'out' | 'in', stableId = exact.ref.stableId): RelationshipContext => ({ relationshipType, direction, with: { ...exact.ref, stableId } });

const answered = (exact: GraphNode, contexts: Record<string, RelationshipContext>, extra: Partial<SearchResult> = {}): SearchResult =>
  answerOf('demo', [exact], { related: relatedOf([hit('demo', 'REF-1'), hit('demo', 'REF-2')], undefined, { 'REF-1': ['ownerRef'] }, contexts), ...extra });

const rowOf = (stableId: string): HTMLElement => {
  const group = screen.getByRole('region', { name: /^Related records/ });
  const row = within(group).getAllByRole('listitem').find((item) => item.textContent?.includes(`Title ${stableId}`));
  if (row === undefined) throw new Error(`no row for ${stableId}`);
  return row;
};

describe('the relationship context line on a related row', () => {
  it('reads "<TYPE> <title>" for a relationship that leaves the record and "<TYPE> from <title>" for one that enters it, and keeps the line of the matched property', async () => {
    const exact = exactNode();
    const kit = searchKit(['demo'], async () => ok(answered(exact, { 'REF-1': contextTo(exact, 'OWNS', 'out'), 'REF-2': contextTo(exact, 'SENT', 'in') })));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await screen.findByRole('region', { name: /^Related records/ });
    expect(within(rowOf('REF-1')).getByText('OWNS Title AC-1')).toBeDefined();
    expect(within(rowOf('REF-1')).getByText('References AC-1 in ownerRef')).toBeDefined();
    expect(within(rowOf('REF-2')).getByText('SENT from Title AC-1')).toBeDefined();
  });

  it('shows no relationship context line, and no placeholder, for a record with none', async () => {
    const exact = exactNode();
    const kit = searchKit(['demo'], async () => ok(answered(exact, { 'REF-1': contextTo(exact, 'OWNS', 'out') })));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await screen.findByRole('region', { name: /^Related records/ });
    expect(rowOf('REF-2').querySelector('.search-hit-relationship')).toBeNull();
    expect(rowOf('REF-1').querySelector('.search-hit-relationship')).not.toBeNull();
    expect(main().querySelectorAll('.search-hit-relationship')).toHaveLength(1);
  });

  it('shows the title the exact match has in the answer, masked when the answer masks it', async () => {
    const exact = exactNode('J••• D••');
    const kit = searchKit(['demo'], async () => ok(answered(exact, { 'REF-1': contextTo(exact, 'OWNS', 'out') })));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await screen.findByRole('region', { name: /^Related records/ });
    expect(within(rowOf('REF-1')).getByText('OWNS J••• D••')).toBeDefined();
  });

  it('shows no line, rather than a guessed title, for a context that names a record the page does not hold', async () => {
    const exact = exactNode();
    const kit = searchKit(['demo'], async () => ok(answered(exact, { 'REF-1': contextTo(exact, 'OWNS', 'out', 'NOT-HERE') })));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await screen.findByRole('region', { name: /^Related records/ });
    expect(main().querySelectorAll('.search-hit-relationship')).toHaveLength(0);
  });

  it('adds no stop to the keyboard path: the only control of a row is still Open in graph, which keeps the focus order', async () => {
    const exact = exactNode();
    const kit = searchKit(['demo'], async () => ok(answered(exact, { 'REF-1': contextTo(exact, 'OWNS', 'out'), 'REF-2': contextTo(exact, 'OWNS', 'out') })));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await screen.findByRole('region', { name: /^Related records/ });
    const group = screen.getByRole('region', { name: /^Related records/ });
    expect(within(group).getAllByRole('button').map((button) => button.textContent)).toEqual(['Open in graph', 'Open in graph']);
    const user = userEvent.setup();
    await user.click(within(rowOf('REF-1')).getByRole('button'));
    await user.tab();
    expect(document.activeElement).toBe(within(rowOf('REF-2')).getByRole('button'));
  });

  it('names a type whose pairs the context read left out, under the related notes', async () => {
    const exact = exactNode();
    const disabled = [{ entityType: 'kind-a', property: 'id', reason: 'index-unavailable' as const, typeSearched: false }];
    const kit = searchKit(['demo'], async () => ok(answered(exact, {}, { related: { ...relatedOf([hit('demo', 'REF-1')]), context: { disabledTypes: disabled } } })));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await screen.findByRole('region', { name: /^Related records/ });
    expect(within(main()).getByText('Relationship context not read for KIND-A')).toBeDefined();
  });
});

describe('a relationship context read that failed', () => {
  const failed = (failure: Record<string, unknown> = {}): SearchResult => answered(exactNode(), {}, { failures: [{ group: 'context', code: 'QUERY_TIMEOUT', timeoutMs: 5000, ...failure }] as SearchResult['failures'] });

  it('keeps every hit, says the relationship context was not read, and puts no line on any row', async () => {
    const kit = searchKit(['demo'], async () => ok(failed()));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await screen.findByRole('region', { name: /^Related records/ });
    expect(within(main()).getByRole('alert').textContent).toBe('Relationship context not read: the source did not answer within 5 s.');
    expect(within(screen.getByRole('region', { name: /^Related records/ })).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('heading', { level: 2, name: 'Exact ID match (1)' })).toBeDefined();
    expect(main().querySelectorAll('.search-hit-relationship')).toHaveLength(0);
    expect(within(main()).getByText('1 exact match · 2 related records · 0.18 s')).toBeDefined();
  });

  it('names the code when it is not a timeout', async () => {
    const kit = searchKit(['demo'], async () => ok(failed({ code: 'SOURCE_BUSY', timeoutMs: undefined })));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await screen.findByRole('region', { name: /^Related records/ });
    expect(within(main()).getByRole('alert').textContent).toBe('Relationship context not read (SOURCE_BUSY).');
  });

  it('repeats the whole search on Retry, and the lines come with the answer that follows', async () => {
    const exact = exactNode();
    let reads = 0;
    const kit = searchKit(['demo'], async () => ok((reads += 1) === 1 ? failed() : answered(exact, { 'REF-1': contextTo(exact, 'OWNS', 'out') })));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await screen.findByRole('region', { name: /^Related records/ });
    await userEvent.setup().click(within(main()).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(within(main()).getByText('OWNS Title AC-1')).toBeDefined());
    expect(reads).toBe(2);
    expect(within(main()).queryByRole('alert')).toBeNull();
  });

  it('shows no note when the read did not fail', async () => {
    const exact = exactNode();
    const kit = searchKit(['demo'], async () => ok(answered(exact, { 'REF-1': contextTo(exact, 'OWNS', 'out') })));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await screen.findByRole('region', { name: /^Related records/ });
    expect(within(main()).queryByText(/Relationship context not read/)).toBeNull();
  });
});
