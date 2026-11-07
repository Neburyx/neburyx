import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SearchMoreRequest, SearchMoreResult, SearchResult, UnreferencedHit } from '@neburyx/contracts';
import type { ApiClient, ApiResult } from '../api/client.js';
import { renderApp } from '../test-utils.js';
import { FILTERS_COPY, UNREFERENCED_TEXT } from './copy.js';
import { answerOf, facetsOf, hit, relatedOf, searchAt, searchKit } from './search-test-kit.js';

const main = () => screen.getByRole('main');
const ok = <Value,>(value: Value): ApiResult<Value> => ({ ok: true, value });
const unreferenced = (title: string): UnreferencedHit => ({ entityType: 'widget', title, properties: [{ key: 'nickname', value: title, dataClass: 'text', masked: false }], reason: 'no-stable-id' });
const DROPPED = { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 };

function kitWith(first: SearchResult, more?: (request: SearchMoreRequest) => Promise<ApiResult<SearchMoreResult>>): ApiClient {
  const kit = searchKit(['demo'], async () => ok(first));
  return more === undefined ? kit.client : { ...kit.client, searchMore: (request) => more(request) };
}

describe('a hit with no usable stable ID on the Search results page', () => {
  it('is listed under its group with the text that it cannot be opened or added, is not a button, and has the reason in its accessible name', async () => {
    const result = answerOf('demo', [hit('demo', 'W-1')], { exactUnreferenced: [unreferenced('Lamp')], counts: { exact: { value: 2, quality: 'exact', scope: 'search:exact' } }, dropped: { ...DROPPED, 'no-stable-id': 1 } });
    renderApp(searchAt('demo', 'needle'), kitWith(result));
    const row = await within(main()).findByRole('listitem', { name: `Lamp, widget: ${UNREFERENCED_TEXT}` });
    expect(within(row).getByText(UNREFERENCED_TEXT)).toBeTruthy();
    expect(within(row).queryByRole('button')).toBeNull();
    expect(within(row).queryByRole('link')).toBeNull();
    expect(row.textContent).not.toContain('Open in graph');
    expect(within(main()).getByRole('heading', { level: 2, name: /\(2\)/ })).toBeTruthy();
  });

  it('is listed in the related group too', async () => {
    const related = { ...relatedOf([]), unreferenced: [unreferenced('Crate')], count: { value: 1, quality: 'exact' as const, scope: 'search:related' } };
    renderApp(searchAt('demo', 'needle'), kitWith(answerOf('demo', [], { related })));
    expect(await within(main()).findByRole('listitem', { name: `Crate, widget: ${UNREFERENCED_TEXT}` })).toBeTruthy();
  });

  it('is listed when every hit of the group is unreferenced, and the page does not say that none could be shown', async () => {
    const result = answerOf('demo', [], { exactUnreferenced: [unreferenced('Lamp'), unreferenced('Desk')], counts: { exact: { value: 2, quality: 'exact', scope: 'search:exact' } }, facets: facetsOf({ total: 2 }) });
    renderApp(searchAt('demo', 'needle'), kitWith(result));
    await within(main()).findByRole('listitem', { name: `Lamp, widget: ${UNREFERENCED_TEXT}` });
    expect(within(main()).getByRole('listitem', { name: `Desk, widget: ${UNREFERENCED_TEXT}` })).toBeTruthy();
    expect(within(main()).queryByText(FILTERS_COPY.unshown)).toBeNull();
    expect(within(main()).queryByText('No matching entities')).toBeNull();
  });

  it('is added from the next page in the order it falls on, with the count the answer gives', async () => {
    const first = answerOf('demo', [hit('demo', 'W-1')], { exactUnreferenced: [unreferenced('Lamp')], counts: { exact: { value: 2, quality: 'lowerBound', scope: 'search:exact' } }, exactNextCursor: 'cursor-1' });
    const page: SearchMoreResult = { sourceId: 'demo', group: 'exact', nodes: [], unreferenced: [unreferenced('Desk')], count: { value: 3, quality: 'exact', scope: 'search:exact' }, dropped: { ...DROPPED, 'no-stable-id': 1 }, warnings: [] };
    renderApp(searchAt('demo', 'needle'), kitWith(first, async () => ok(page)));
    await within(main()).findByRole('listitem', { name: `Lamp, widget: ${UNREFERENCED_TEXT}` });
    await userEvent.setup().click(within(main()).getByRole('button', { name: 'Show more: Exact matches' }));
    const added = await within(main()).findByRole('listitem', { name: `Desk, widget: ${UNREFERENCED_TEXT}` });
    const rows = within(main()).getAllByRole('listitem');
    expect(rows.indexOf(added)).toBeGreaterThan(rows.indexOf(within(main()).getByRole('listitem', { name: `Lamp, widget: ${UNREFERENCED_TEXT}` })));
    await waitFor(() => expect(document.activeElement).toBe(added));
    expect(within(main()).getByRole('heading', { level: 2, name: /\(3\)/ })).toBeTruthy();
  });
});
