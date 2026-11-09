import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { SearchMoreRequest, SearchMoreResult, SearchResult, SourceProfile } from '@neburyx/contracts';
import type { ApiClient, ApiResult } from '../api/client.js';
import { renderApp } from '../test-utils.js';
import { registerViewEvidence } from './evidence-action.js';
import { aggregateHit, answerOf, evidenceHit, evidenceOf, searchAt, searchKit } from './search-test-kit.js';

const main = () => screen.getByRole('main');
const ok = <Value,>(value: Value): ApiResult<Value> => ({ ok: true, value });
const DROPPED = { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 };
const region = (count: string) => screen.findByRole('region', { name: `Evidence records · Supporting relationships (${count})` });
const rowsOf = (section: HTMLElement) => within(section).getAllByRole('listitem').filter((item) => item.parentElement?.classList.contains('search-hits') === true);

const answering = (evidence: SearchResult['evidence']) => searchKit(['demo'], async () => ok(answerOf('demo', [], { evidence })));

function withMore(first: SearchResult['evidence'], pages: readonly SearchMoreResult[]) {
  const kit = answering(first);
  const asked: SearchMoreRequest[] = [];
  const client: ApiClient = {
    ...kit.client,
    searchMore: (request) => {
      asked.push(request);
      const page = pages[asked.length - 1];
      return page === undefined ? Promise.reject(new Error('no page')) : Promise.resolve(ok(page));
    },
  };
  return { client, asked };
}

const evidencePage = (hits: Extract<SearchMoreResult, { group: 'evidence' }>['hits'], value: number, nextCursor?: string): SearchMoreResult => ({
  sourceId: 'demo',
  group: 'evidence',
  hits,
  count: { value, quality: nextCursor === undefined ? 'exact' : 'lowerBound', scope: 'search:evidence' },
  ...(nextCursor === undefined ? {} : { nextCursor }),
  dropped: DROPPED,
  warnings: [],
});

describe('an aggregate of relationships with no stable ID in the evidence group', () => {
  let unregister: (() => void) | undefined;
  afterEach(() => unregister?.());

  it('shows the relationship type, both ends, the member count, and each member with its element ID, records and time', async () => {
    const hit = aggregateHit([{ elementId: '5:n:1', records: [{ sourceRecordId: 'REC-1' }, { sourceRecordId: 'DOC-7' }], observedAt: '2026-03-01T10:00:00Z' }, '5:n:2']);
    renderApp(searchAt('demo', 'REC-1'), answering(evidenceOf([hit])).client);
    const [row] = rowsOf(await region('2'));
    if (row === undefined) throw new Error('no row');
    expect(within(row).getByText('SEEN_WITH')).toBeDefined();
    expect(within(row).getByText('KIND-A W-1 → KIND-A W-2')).toBeDefined();
    expect(within(row).getByText('2 relationships')).toBeDefined();
    expect(within(row).getByText('Element ID 5:n:1 · 2 records: REC-1, DOC-7 · observed 2026-03-01T10:00:00Z')).toBeDefined();
    expect(within(row).getByText('Element ID 5:n:2 · 1 record: REC-1')).toBeDefined();
  });

  it('counts an aggregate of 3 members as 3 relationships and names the rule that uses its type', async () => {
    const hit = { ...aggregateHit(['5:n:1', '5:n:2', '5:n:3']), rules: [{ ruleId: 'SD-01', ruleVersion: 2 }] };
    renderApp(searchAt('demo', 'REC-1'), answering(evidenceOf([hit], { value: 3, quality: 'exact', scope: 'search:evidence' })).client);
    const [row] = rowsOf(await region('3'));
    if (row === undefined) throw new Error('no row');
    expect(within(row).getByText('3 relationships')).toBeDefined();
    expect(within(row).getByText('Rule SD-01 v2 uses this relationship type')).toBeDefined();
  });

  it('offers nothing to open, copy or view for the aggregate or a member, and says why: its element ID is text', async () => {
    unregister = registerViewEvidence(() => undefined);
    renderApp(searchAt('demo', 'REC-1'), answering(evidenceOf([evidenceHit('L-1'), aggregateHit(['5:n:1'])])).client);
    const section = await region('2');
    const [, aggregate] = rowsOf(section);
    if (aggregate === undefined) throw new Error('no aggregate row');
    expect(within(aggregate).queryAllByRole('button')).toEqual([]);
    expect(within(aggregate).queryAllByRole('link')).toEqual([]);
    expect(within(aggregate).queryByText(/Copy ID/)).toBeNull();
    expect(within(aggregate).getByText('No stable ID: each relationship is listed by its element ID and cannot be opened or copied as an ID')).toBeDefined();
    expect(within(section).getAllByRole('button', { name: /View evidence/ })).toHaveLength(1);
  });

  it('shows the end of a keyed entity type by its type alone, never its reference token', async () => {
    const keyed = (profile: SourceProfile): SourceProfile => ({ ...profile, entityTypes: profile.entityTypes.map((type) => ({ ...type, keyed: true })) });
    const kit = answering(evidenceOf([aggregateHit(['5:n:1'], { from: 'k1.token-value' })]));
    const client: ApiClient = {
      ...kit.client,
      getProfile: async (sourceId, signal) => {
        const answer = await kit.client.getProfile(sourceId, signal);
        return answer.ok ? ok(keyed(answer.value)) : answer;
      },
    };
    renderApp(searchAt('demo', 'REC-1'), client);
    const [row] = rowsOf(await region('1'));
    expect(row?.textContent).not.toContain('k1.token-value');
    expect(within(row ?? document.body).getByText('KIND-A → KIND-A')).toBeDefined();
  });

  it('says the member count is a lower bound while the group has a next page', async () => {
    const members = Array.from({ length: 25 }, (_, index) => `5:n:${index + 1}`);
    renderApp(searchAt('demo', 'REC-1'), answering({ ...evidenceOf([aggregateHit(members, { quality: 'lowerBound' })]), count: { value: 25, quality: 'lowerBound', scope: 'search:evidence' }, nextCursor: 'evidence-1' }).client);
    const [row] = rowsOf(await region('≥ 25 · lower bound'));
    expect(within(row ?? document.body).getByText('≥ 25 relationships · lower bound')).toBeDefined();
  });

  it('adds the members of the next page to the same aggregate, each once, puts the focus on the first new member, and counts them exactly once the last page is read', async () => {
    const first = { ...evidenceOf([aggregateHit(['5:n:1', '5:n:2'], { quality: 'lowerBound' })]), count: { value: 2, quality: 'lowerBound' as const, scope: 'search:evidence' }, nextCursor: 'evidence-1' };
    const { client, asked } = withMore(first, [evidencePage([aggregateHit(['5:n:2', '5:n:3', '5:n:4'], { quality: 'lowerBound' }), aggregateHit(['5:n:5'], { to: 'W-9', quality: 'lowerBound' })], 6)]);
    renderApp(searchAt('demo', 'REC-1'), client);
    await region('≥ 2 · lower bound');
    await userEvent.setup().click(within(main()).getByRole('button', { name: 'Show more: Evidence records' }));
    const section = await region('6');
    const rows = rowsOf(section);
    expect(rows).toHaveLength(2);
    const [merged, other] = rows;
    expect(within(merged ?? document.body).getAllByText(/^Element ID /).map((member) => member.textContent?.split(' · ')[0])).toEqual(['Element ID 5:n:1', 'Element ID 5:n:2', 'Element ID 5:n:3', 'Element ID 5:n:4']);
    expect(within(merged ?? document.body).getByText('4 relationships')).toBeDefined();
    expect(within(other ?? document.body).getByText('KIND-A W-1 → KIND-A W-9')).toBeDefined();
    expect(document.activeElement?.textContent).toBe('Element ID 5:n:3 · 1 record: REC-1');
    expect(asked.map((page) => [page.group, page.cursor])).toEqual([['evidence', 'evidence-1']]);
  });
});

describe('an evidence value that cannot be shown', () => {
  it('says "Value cannot be shown" with the property name, in a stored hit and in a member, and the row is still counted', async () => {
    const unreadable = { property: 'docId', unreadable: true as const };
    const hits = [evidenceHit('L-1', { records: ['REC-1', unreadable] }), evidenceHit('L-2', { records: [unreadable] }), aggregateHit([{ elementId: '5:n:1', records: [unreadable] }])];
    renderApp(searchAt('demo', 'REC-1'), answering(evidenceOf(hits)).client);
    const section = await region('3');
    const rows = rowsOf(section);
    expect(rows).toHaveLength(3);
    expect(within(rows[0] ?? document.body).getByText('2 records: REC-1, docId: Value cannot be shown')).toBeDefined();
    expect(within(rows[1] ?? document.body).getByText('1 record: docId: Value cannot be shown')).toBeDefined();
    expect(within(rows[2] ?? document.body).getByText('Element ID 5:n:1 · 1 record: docId: Value cannot be shown')).toBeDefined();
    for (const row of rows) expect(row.textContent).not.toMatch(/:\s*(,|$)/);
  });
});
