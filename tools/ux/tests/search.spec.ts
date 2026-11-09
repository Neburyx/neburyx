import { expect, test, type Page } from '@playwright/test';

const SOURCE = 'banking-demo';
const SECOND = 'second-demo';

const box = (page: Page) => page.getByRole('searchbox', { name: 'Search text' });
const groupTitle = (page: Page, title: string) => page.getByRole('heading', { level: 2, name: title });

/** Opens the search page of a source and searches a text the way a person does: typed into the box. The address never holds the text. */
async function searchFor(page: Page, text: string, source = SOURCE): Promise<void> {
  await page.goto(`/search?source=${source}`);
  await box(page).fill(text);
  await box(page).press('Enter');
  expect(new URL(page.url()).search, 'the address holds the source and never the text').toBe(`?source=${source}`);
}

test.describe('searching for an entity', () => {
  test('shows the exact match of an ID and opens it in Explore with that one entity', async ({ page }) => {
    await searchFor(page, 'AC-1');
    await expect(page.getByRole('heading', { level: 1, name: 'Search results' })).toBeVisible();
    await expect(groupTitle(page, 'Exact ID match (1)')).toBeVisible();
    await expect(page.getByText('1 exact match · 0.18 s')).toBeVisible();
    await expect(page.getByText('Matches AC-1 in code')).toBeVisible();
    await expect(page.getByText(`Searches only configured, indexed properties in ${SOURCE}.`)).toBeVisible();
    await page.getByRole('button', { name: /^Open in graph/ }).click();
    await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('account AC-1');
    await expect(page.getByText('1 entity · 0 relationships · loaded · exact')).toBeVisible();
  });

  test('says there is no match for an ID the source does not hold, and keeps the box and its text', async ({ page }) => {
    await searchFor(page, 'missing-1');
    await expect(page.getByRole('heading', { level: 2, name: 'No matching entities' })).toBeVisible();
    await expect(page.getByText('Check the ID or try another indexed property.')).toBeVisible();
    await expect(box(page)).toHaveValue('missing-1');
  });

  test('reads 25 matches as exact and 26 as "≥ 25 · lower bound"', async ({ page }) => {
    await searchFor(page, 'many-25');
    await expect(groupTitle(page, 'Exact ID match (25)')).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'Open in graph' })).toHaveCount(25);
    await searchFor(page, 'many-26');
    await expect(groupTitle(page, 'Exact ID match (≥ 25 · lower bound)')).toBeVisible();
    await expect(page.getByText('≥ 25 exact matches · lower bound · 0.18 s')).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'Open in graph' })).toHaveCount(25);
  });

  test('reaches every match of a group with Show more, by keyboard: the hits stay, the next ones are added, the focus is on the first new one, and the last page has none', async ({ page }) => {
    await searchFor(page, 'many-61');
    await expect(groupTitle(page, 'Exact ID match (≥ 25 · lower bound)')).toBeVisible();
    const more = page.getByRole('button', { name: 'Show more: Exact matches' });
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(groupTitle(page, 'Exact ID match (≥ 50 · lower bound)')).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'Open in graph' })).toHaveCount(50);
    await expect(page.locator(':focus')).toContainText('many-61-26');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: /^Open in graph: .*many-61-26/ })).toBeFocused();
    await more.focus();
    await page.keyboard.press('Space');
    await expect(groupTitle(page, 'Exact ID match (61)')).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'Open in graph' })).toHaveCount(61);
    await expect(more).toHaveCount(0);
    await expect(page.locator(':focus')).toContainText('many-61-51');
  });

  test('offers a new search when the next page is no longer valid, and keeps the hits', async ({ page }) => {
    await page.route((url) => url.pathname === '/v1/search/entities/more', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'CURSOR_INVALIDATED', message: 'This page of results is no longer valid. Start again.', retryable: false, traceId: 'tr-ux' } }) }));
    await searchFor(page, 'many-30');
    await page.getByRole('button', { name: 'Show more: Exact matches' }).click();
    await expect(page.getByRole('alert')).toContainText('This page of results is no longer valid. Search again to see the rest.');
    await expect(page.getByRole('listitem').filter({ hasText: 'Open in graph' })).toHaveCount(25);
    await page.getByRole('button', { name: 'Search again' }).click();
    await expect(page.getByRole('button', { name: 'Show more: Exact matches' })).toBeVisible();
  });

  test('shows the timed-out state when the source stalls, and Retry shows the results', async ({ page }, info) => {
    await searchFor(page, `stall-${info.project.name}`);
    await expect(page.getByRole('alert')).toContainText('Search timed out after 5 s');
    await expect(page.getByRole('alert')).toContainText('Your graph was not changed.');
    await expect(box(page)).toHaveValue(`stall-${info.project.name}`);
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(groupTitle(page, 'Exact ID match (1)')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('submits a new search from the box with Enter, and the back button shows the earlier one', async ({ page }) => {
    await searchFor(page, 'AC-1');
    await expect(page.getByText('account AC-1')).toBeVisible();
    await box(page).fill('AC-2');
    await box(page).press('Enter');
    expect(new URL(page.url()).search).toBe(`?source=${SOURCE}`);
    await expect(page.getByText('account AC-2')).toBeVisible();
    await page.goBack();
    await expect(box(page)).toHaveValue('AC-1');
    await expect(page.getByText('account AC-1')).toBeVisible();
  });
});

test.describe('related records', () => {
  test('lists them after the exact match with the property that holds the ID, and opens one by keyboard in Explore with that one entity', async ({ page }) => {
    await searchFor(page, 'rel-3');
    await expect(groupTitle(page, 'Exact ID match (1)')).toBeVisible();
    await expect(groupTitle(page, 'Related records · Referenced ID (3)')).toBeVisible();
    await expect(page.getByText('1 exact match · 3 related records · 0.18 s')).toBeVisible();
    await expect(page.getByText('Related records reference the ID; they are not extra exact matches.')).toBeVisible();
    await expect(page.getByText('References rel-3 in batchRef')).toHaveCount(3);
    const first = page.getByRole('region', { name: 'Related records · Referenced ID (3)' }).getByRole('button', { name: /^Open in graph/ }).first();
    await first.focus();
    await expect(first).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('account rel-3-r01');
    await expect(page.getByText('1 entity · 0 relationships · loaded · exact')).toBeVisible();
  });

  test('reads 26 related records as "≥ 25 · lower bound" and shows 25 rows', async ({ page }) => {
    await searchFor(page, 'rel-26');
    await expect(groupTitle(page, 'Related records · Referenced ID (≥ 25 · lower bound)')).toBeVisible();
    await expect(page.getByText('1 exact match · ≥ 25 related records · lower bound · 0.18 s')).toBeVisible();
    await expect(page.getByRole('region', { name: /Related records/ }).getByRole('listitem')).toHaveCount(25);
  });

  test('names a type left out of the related group, and says why a group was not searched without reading "No matching entities" for it', async ({ page }) => {
    await searchFor(page, 'reldrop-1');
    await expect(page.getByText(/^Not searched for related records: .*, none of its properties · batchRef: index is building$/)).toBeVisible();
    await expect(page.getByText('No property of this source is configured for related records.')).toHaveCount(0);
    await searchFor(page, 'missing-1');
    await expect(page.getByRole('heading', { level: 2, name: 'No matching entities' })).toBeVisible();
    await expect(page.getByText('No property of this source is configured for related records.')).toBeVisible();
  });

  test('keeps the exact group and says that the related records were not read when their read fails, and Retry repeats the search', async ({ page }) => {
    await searchFor(page, 'relfail-1');
    await expect(groupTitle(page, 'Exact ID match (1)')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveText('Related records were not read: the source did not answer within 5 s.');
    await expect(page.getByText('1 exact match · related records not read · 0.18 s')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'No matching entities' })).toHaveCount(0);
    await expect(page.getByText(/0 related/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(groupTitle(page, 'Exact ID match (1)')).toBeVisible();
  });

  test('keeps the related group and says that the exact matches were not read when that read fails', async ({ page }) => {
    await searchFor(page, 'exactfail-1');
    await expect(groupTitle(page, 'Related records · Referenced ID (2)')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveText('Exact matches were not read: the source did not answer within 5 s.');
    await expect(page.getByText('exact matches not read · 2 related records · 0.18 s')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /Exact ID match/ })).toHaveCount(0);
  });
});

test.describe('⌘K', () => {
  test('opens the search page from Home with the box focused', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page).toHaveURL(/\/search/);
    await expect(box(page)).toBeFocused();
  });

  test('opens the Search panel in Explore, and leaves the page where it is', async ({ page }) => {
    await page.goto('/explore');
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page).toHaveURL(/\/explore$/);
    await expect(page.getByRole('searchbox', { name: 'Find on canvas' })).toBeFocused();
  });

  test('focuses the box and selects its text on the search page', async ({ page }) => {
    await searchFor(page, 'AC-1');
    await expect(groupTitle(page, 'Exact ID match (1)')).toBeVisible();
    await page.getByRole('button', { name: 'Search', exact: true }).focus();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(box(page)).toBeFocused();
    expect(await box(page).evaluate((input: HTMLInputElement) => input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0))).toBe('AC-1');
  });
});

test.describe('two configured sources', () => {
  test('show a selector, and a change searches the new source only', async ({ page }) => {
    const searched: string[] = [];
    const profile = await (await page.request.get(`/v1/sources/${SOURCE}/profile`)).json();
    const sources = await (await page.request.get('/v1/sources')).json();
    await page.route((url) => url.pathname === '/v1/sources', (route) => route.fulfill({ json: { items: [...sources.items, { ...sources.items[0], id: SECOND, alias: SECOND }], nextCursor: null } }));
    await page.route((url) => url.pathname === `/v1/sources/${SECOND}/profile`, (route) => route.fulfill({ json: { ...profile, sourceId: SECOND } }));
    await page.route((url) => url.pathname === '/v1/search/entities', async (route) => {
      const body = route.request().postDataJSON();
      searched.push(body.sourceId);
      if (body.sourceId !== SECOND) return route.fallback();
      const node = { ref: { sourceId: SECOND, entityType: 'account', stableId: body.text }, display: { title: `second ${body.text}`, type: 'account' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } };
      return route.fulfill({ json: { sourceId: SECOND, exact: [node], exactMatches: [{ ref: node.ref, matchedProperties: ['code'] }], cap: 25, searchable: true, counts: { exact: { value: 1, quality: 'exact', scope: 'search:exact' } }, disabledTypes: [], related: { hits: [], count: { value: 0, quality: 'exact', scope: 'search:related' }, searchable: false, disabledTypes: [] }, evidence: { hits: [], count: { value: 0, quality: 'exact', scope: 'search:evidence' }, searchable: false, disabledRelationshipTypes: [] }, failures: [], dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 }, warnings: [], elapsedMs: 120, facets: { searchable: false }, filters: { entityTypes: [], matchModes: [] } } });
    });
    await searchFor(page, 'AC-1');
    const selector = page.getByRole('combobox', { name: 'Source' });
    await expect(selector).toHaveValue(SOURCE);
    await expect(page.getByText('account AC-1')).toBeVisible();
    await selector.focus();
    await selector.selectOption(SECOND);
    await expect(page).toHaveURL(new RegExp(`source=${SECOND}`));
    await expect(page.getByText('second AC-1')).toBeVisible();
    await expect(page.getByText('account AC-1')).toHaveCount(0);
    await expect(page.getByText(`Searches only configured, indexed properties in ${SECOND}.`)).toBeVisible();
    await expect(selector).toBeFocused();
    expect(searched).toEqual([SOURCE, SECOND]);
  });
});

test.describe('an entity whose ID is made of dots', () => {
  for (const id of ['.', '..']) {
    test(`finds "${id}", opens it in Explore, and draws it again from the address after a reload`, async ({ page }) => {
      const requested: string[] = [];
      page.on('request', (request) => {
        if (request.url().includes('/v1/entities/')) requested.push(new URL(request.url()).pathname);
      });
      await searchFor(page, id);
      await expect(groupTitle(page, 'Exact ID match (1)')).toBeVisible();
      await page.getByRole('button', { name: /^Open in graph/ }).click();
      await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(`account ${id}`);
      await page.reload();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(`account ${id}`);
      expect(requested, 'the reload read the entity by a path no URL parser shortens').toContain(`/v1/entities/${SOURCE}/account/~${id}`);
    });
  }
});

test('sends a text of one character, and does not send an empty one', async ({ page }) => {
  const searched: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/v1/search/entities')) searched.push(request.postData() ?? '');
  });
  await page.goto(`/search?source=${SOURCE}`);
  await box(page).press('Enter');
  await expect(page.getByText('Type something to search.')).toBeVisible();
  expect(searched).toEqual([]);
  await box(page).fill('X');
  await box(page).press('Enter');
  await expect(groupTitle(page, 'Exact ID match (1)')).toBeVisible();
  expect(searched).toHaveLength(1);
});

test('keeps the search through a reload and Back, from the history state, with the text never in the address', async ({ page }) => {
  await searchFor(page, 'AC-1');
  await expect(page.getByText('account AC-1')).toBeVisible();
  await page.reload();
  await expect(box(page)).toHaveValue('AC-1');
  await expect(page.getByText('account AC-1')).toBeVisible();
  expect(new URL(page.url()).search).toBe(`?source=${SOURCE}`);
});
