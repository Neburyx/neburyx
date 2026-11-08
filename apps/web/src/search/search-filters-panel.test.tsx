import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SearchResult } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { renderApp } from '../test-utils.js';
import { answerOf, FACETS_FAILURE, FAILED_FACETS, facetsOf, hit, searchAt, searchKit, withFacets } from './search-test-kit.js';

const TYPES = ['kind-a', 'kind-b'] as const;
const main = () => screen.getByRole('main');
const filters = () => screen.getByRole('complementary', { name: 'Filters' });
const ok = (value: SearchResult): ApiResult<SearchResult> => ({ ok: true, value });
const FULL = facetsOf({ total: 5, types: [['kind-a', 3], ['kind-b', 2]], modes: [['exact', 4], ['related', 1], ['evidence', 7]] });

const render = async (answer: () => ApiResult<SearchResult>, address = '') => {
  const kit = searchKit(['demo'], async () => answer(), { types: TYPES });
  const view = renderApp(searchAt('demo', 'AC', address), kit.client);
  await screen.findByRole('complementary', { name: 'Filters' });
  return { kit, view };
};

describe('the Filters of the Search results page', () => {
  it('shows an entry for each entity type and match mode of the answer, in its order, with its count and a checkbox, and the total', async () => {
    await render(() => withFacets('demo', [hit('demo', 'AC-1')], FULL));
    const panel = within(filters());
    expect(panel.getAllByRole('group').map((group) => group.querySelector('legend')?.textContent)).toEqual(['Entity type', 'Match mode']);
    expect(panel.getAllByRole('checkbox').map((box) => box.closest('label')?.textContent)).toEqual(['KIND-A3', 'KIND-B2', 'Exact ID4', 'Referenced ID1', 'Evidence record7']);
    expect(panel.getAllByRole('checkbox').every((box) => box instanceof HTMLInputElement && !box.checked)).toBe(true);
    expect(panel.getByText('5 entities · 7 supporting relationships')).toBeDefined();
  });

  it('says a count as the page says every count: the number, "≥ 25 · lower bound" or "0", and the total the same, and says the returned value for a smaller cap', async () => {
    const capped = facetsOf({ total: [25, 'lowerBound'], types: [['kind-a', [25, 'lowerBound']], ['kind-b', 0]], modes: [['exact', [10, 'lowerBound']]] });
    await render(() => withFacets('demo', [hit('demo', 'AC-1')], capped));
    const panel = within(filters());
    expect(panel.getByText('≥ 25 · lower bound')).toBeDefined();
    expect(panel.getByText('≥ 10 · lower bound')).toBeDefined();
    expect(panel.getByText('0')).toBeDefined();
    expect(panel.getByText('≥ 25 entities · lower bound')).toBeDefined();
  });

  it('says one result in the singular, and adds no count together', async () => {
    await render(() => withFacets('demo', [hit('demo', 'AC-1')], facetsOf({ total: 1, types: [['kind-a', 1], ['kind-b', 1]] })));
    expect(within(filters()).getByText('1 entity')).toBeDefined();
  });

  it('shows no Reset while nothing is chosen, and the boxes of the address checked', async () => {
    await render(() => withFacets('demo', [hit('demo', 'AC-1')], FULL), '&type=kind-b&mode=exact');
    const panel = within(filters());
    expect(panel.getByRole('checkbox', { name: /KIND-B/ })).toHaveProperty('checked', true);
    expect(panel.getByRole('checkbox', { name: /Exact ID/ })).toHaveProperty('checked', true);
    expect(panel.getByRole('checkbox', { name: /KIND-A/ })).toHaveProperty('checked', false);
    expect(panel.getByRole('button', { name: 'Reset' })).toBeDefined();
  });

  it('draws no Reset while nothing is chosen', async () => {
    await render(() => withFacets('demo', [hit('demo', 'AC-1')], FULL));
    expect(within(filters()).queryByRole('button', { name: 'Reset' })).toBeNull();
  });

  it('puts the panel after the search form in the tab order, and a checkbox is operated by the keyboard', async () => {
    await render(() => withFacets('demo', [hit('demo', 'AC-1')], FULL));
    const user = userEvent.setup();
    const box = screen.getByRole('searchbox', { name: 'Search text' });
    box.focus();
    const stops: string[] = [];
    for (let presses = 0; presses < 3; presses += 1) {
      await user.tab();
      stops.push(document.activeElement?.closest('label')?.textContent ?? document.activeElement?.textContent ?? '');
    }
    expect(stops).toEqual(['Search', 'KIND-A3', 'KIND-B2']);
  });

  it('gives each checkbox the shared control look: no class of its own and no browser default for the panel', async () => {
    await render(() => withFacets('demo', [hit('demo', 'AC-1')], FULL));
    for (const box of within(filters()).getAllByRole('checkbox')) expect(box.className).toBe('');
  });
});

describe('the Filters when the facet read failed', () => {
  const failedAnswer = (exact = [hit('demo', 'AC-1')]) => ok(answerOf('demo', exact, { facets: FAILED_FACETS, failures: [FACETS_FAILURE] }));

  it('on a first answer says that the filters are unavailable, offers Retry, and shows no number and no checkbox', async () => {
    await render(() => failedAnswer());
    const panel = within(filters());
    expect(panel.getByText('Filters unavailable: counts not read')).toBeDefined();
    expect(panel.getByRole('button', { name: 'Retry' })).toBeDefined();
    expect(panel.queryAllByRole('checkbox')).toEqual([]);
    expect(panel.queryByText(/result/)).toBeNull();
    expect(within(main()).getByRole('heading', { level: 2, name: 'Exact ID match (1)' })).toBeDefined();
  });

  it('on a first answer says the filters are unavailable, offers Retry and Reset and draws no box when something is chosen in the address', async () => {
    await render(() => failedAnswer(), '&type=kind-a&mode=exact');
    const panel = within(filters());
    expect(panel.getByText('Filters unavailable: counts not read')).toBeDefined();
    expect(panel.queryByText('Counts not read')).toBeNull();
    expect(panel.getByRole('button', { name: 'Retry' })).toBeDefined();
    expect(panel.getByRole('button', { name: 'Reset' })).toBeDefined();
    expect(panel.queryAllByRole('checkbox')).toEqual([]);
  });

  it('after an answer with counts keeps its entries without their numbers, and says the counts were not read', async () => {
    let calls = 0;
    const kit = searchKit(['demo'], async () => (calls++ === 0 ? withFacets('demo', [hit('demo', 'AC-1')], FULL) : failedAnswer()), { types: TYPES });
    renderApp(searchAt('demo', 'AC'), kit.client);
    await screen.findByText('5 entities · 7 supporting relationships');
    await userEvent.setup().click(within(filters()).getByRole('checkbox', { name: /KIND-A/ }));
    await screen.findByText('Counts not read');
    const panel = within(filters());
    expect(panel.getAllByRole('checkbox').map((box) => box.closest('label')?.textContent)).toEqual(['KIND-A', 'KIND-B', 'Exact ID', 'Referenced ID', 'Evidence record']);
    expect(panel.queryByText(/results?$/)).toBeNull();
    expect(panel.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('when there is nothing to filter', () => {
  it('draws no Filters for an answer with nothing to count', async () => {
    const kit = searchKit(['demo'], async () => withFacets('demo', [hit('demo', 'AC-1')], { searchable: false }), { types: TYPES });
    renderApp(searchAt('demo', 'AC'), kit.client);
    await within(main()).findByRole('heading', { level: 2, name: 'Exact ID match (1)' });
    expect(screen.queryByRole('complementary', { name: 'Filters' })).toBeNull();
  });

  it('draws no Filters while the first answer is loading', async () => {
    const kit = searchKit(['demo'], () => new Promise<ApiResult<SearchResult>>(() => undefined), { types: TYPES });
    renderApp(searchAt('demo', 'AC'), kit.client);
    await within(main()).findByText('Searching…');
    expect(screen.queryByRole('complementary', { name: 'Filters' })).toBeNull();
  });
});

describe('the total of the Filters says what it counts', () => {
  const total = (entities: number | readonly [number, 'lowerBound'], evidence: number | readonly [number, 'lowerBound'] | undefined) =>
    facetsOf({ total: entities, types: [['kind-a', 0]], modes: evidence === undefined ? [['exact', 0]] : [['exact', 0], ['evidence', evidence]] });

  it('reads "0 entities · 25 supporting relationships" for a text that finds only evidence records, and never "0 results"', async () => {
    await render(() => withFacets('demo', [], total(0, 25)));
    expect(within(filters()).getByText('0 entities · 25 supporting relationships')).toBeDefined();
    expect(within(filters()).queryByText(/results/)).toBeNull();
  });

  it('says a lower bound of evidence records as a lower bound', async () => {
    await render(() => withFacets('demo', [], total(0, [25, 'lowerBound'])));
    expect(within(filters()).getByText('0 entities · ≥ 25 supporting relationships · lower bound')).toBeDefined();
  });

  it('adds the evidence part after the entities, whatever the entity total, in the singular and as a lower bound', async () => {
    await render(() => withFacets('demo', [hit('demo', 'AC-1')], total(1, 1)));
    expect(within(filters()).getByText('1 entity · 1 supporting relationship')).toBeDefined();
  });

  it.each([
    ['an evidence count of zero', total(3, 0), '3 entities'],
    ['no evidence entry (the mode was not searched)', total(3, undefined), '3 entities'],
  ])('shows the entity part only for %s', async (_name, facets, text) => {
    await render(() => withFacets('demo', [hit('demo', 'AC-1')], facets));
    expect(within(filters()).getByText(text)).toBeDefined();
  });

  it('shows the entity part only when the evidence count was not read', async () => {
    const unread = { ...facetsOf({ total: 3, types: [['kind-a', 0]] }), matchMode: [{ mode: 'evidence' as const, count: { quality: 'unknown' as const, scope: 'search:facet:matchMode' as const } }] };
    await render(() => withFacets('demo', [hit('demo', 'AC-1')], unread));
    expect(within(filters()).getByText('3 entities')).toBeDefined();
  });

  it('is the answer\'s total under a selection, which does not change what it counts', async () => {
    await render(() => withFacets('demo', [], total(0, 25)), '&mode=evidence');
    expect(within(filters()).getByText('0 entities · 25 supporting relationships')).toBeDefined();
  });
});
