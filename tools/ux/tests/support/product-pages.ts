import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { modifier } from './workspace.ts';

export interface ProductPage {
  readonly name: string;
  readonly route: string;
}

function readPages(): ProductPage[] {
  const parsed: unknown = JSON.parse(readFileSync(new URL('./product-pages.json', import.meta.url), 'utf8'));
  const pages = typeof parsed === 'object' && parsed !== null && 'pages' in parsed && Array.isArray(parsed.pages) ? parsed.pages : [];
  return pages.flatMap((item: unknown) => (typeof item === 'object' && item !== null && 'name' in item && typeof item.name === 'string' && 'route' in item && typeof item.route === 'string' ? [{ name: item.name, route: item.route }] : []));
}

/** The pages and states the check of the browser's default look visits: every product route, with the states that hold controls. */
export const PRODUCT_PAGES: readonly ProductPage[] = readPages();

const unique = (): string => String(Date.now()).slice(-7);

async function openEntity(page: Page, source: string, stableId: string): Promise<void> {
  await page.goto(`/${source}/entity/account/${stableId}`);
  await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
}

/** Opens an entity under a case reference the support server reads back as a changed source, and loads the page again so that it is read as it is now. */
async function openChangedSource(page: Page, kind: 'repointed' | 'removed'): Promise<void> {
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill(`PS-${unique()}`);
  await form.getByLabel('Case reference (optional)').fill(`${kind}-${unique()}`);
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
  await page.reload();
}

async function searchFor(page: Page, text: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('searchbox', { name: 'Search text' }).fill(text);
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(/\/search\?source=/);
}

async function openPrompt(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open a deep link' }).click();
  await expect(page.getByRole('form', { name: 'Open a link' })).toBeVisible();
}

async function openAddTab(page: Page): Promise<void> {
  await openEntity(page, 'banking-demo', `PT-${unique()}`);
  await expect(page.getByRole('application', { name: 'Graph canvas' })).toBeVisible();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('tab', { name: /Add from source/ }).click();
  await expect(page.getByRole('searchbox', { name: 'Find in the source' })).toBeVisible();
}

async function abort(page: Page, matches: (url: URL) => boolean): Promise<void> {
  await page.route(matches, (route) => route.abort());
}
const isSources = (url: URL): boolean => url.pathname === '/v1/sources';
const isProfile = (url: URL): boolean => /^\/v1\/sources\/[^/]+\/profile$/.test(url.pathname);

/** Brings the page to the state of each entry, and waits until the controls of that state are on screen. */
export const REACH: Readonly<Record<string, (page: Page) => Promise<void>>> = {
  'Home with Recent rows': async (page) => {
    await openEntity(page, 'banking-demo', `PA-${unique()}`);
    await openEntity(page, 'claims-demo', `PB-${unique()}`);
    await page.request.post('/__support/sources', { data: { 'banking-demo': { demoCase: { entityType: 'account', stableId: 'DEMO-1', caseRef: 'REF-DEMO-1' } } } });
    await page.goto('/');
    await expect(page.locator('.recent-row').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open the demo case' })).toBeVisible();
  },
  'First run': async (page) => {
    await page.request.post('/__support/forget-investigations');
    await page.request.post('/__support/sources', { data: { 'banking-demo': { demoCase: { entityType: 'account', stableId: 'DEMO-1', caseRef: 'REF-DEMO-1' } } } });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Open demo case' })).toBeVisible();
  },
  'Home with the prompt open': openPrompt,
  "Home with the prompt's problem lines": async (page) => {
    await openPrompt(page);
    await page.getByRole('form', { name: 'Open a link' }).getByLabel('Link', { exact: true }).fill('not a link');
    await page.getByRole('form', { name: 'Open a link' }).getByRole('button', { name: 'Open' }).click();
    await page.getByRole('form', { name: 'Open by parts' }).getByRole('button', { name: 'Open' }).click();
    await expect(page.getByRole('alert')).toHaveCount(2);
  },
  'Home with the Help menu open': async (page) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Help' }).click();
    await expect(page.getByRole('menu', { name: 'Help' })).toBeVisible();
  },
  'Home with the shortcut sheet open': async (page) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Help' }).click();
    await page.getByRole('menuitem', { name: /^Keyboard shortcuts/ }).click();
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  },
  'Home with the list read failed': async (page) => {
    await abort(page, (url) => url.pathname === '/v1/investigations');
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  },
  'Investigations with rows': async (page) => {
    await page.request.post('/__support/forget-investigations');
    await page.request.post('/__support/seed-investigations', { data: { count: 30, sourceId: 'banking-demo', viewEvery: 10 } });
    await page.goto('/investigations');
    await expect(page.getByRole('button', { name: 'Show more' })).toBeVisible();
  },
  'Investigations with a row menu open': async (page) => {
    await page.request.post('/__support/forget-investigations');
    await page.request.post('/__support/seed-investigations', { data: { count: 3, sourceId: 'banking-demo', viewEvery: 0 } });
    await page.goto('/investigations');
    await page.getByRole('button', { name: 'Actions for Case 1', exact: true }).click();
    await expect(page.getByRole('menu')).toBeVisible();
  },
  'Investigations with the Saved views tab': async (page) => {
    await page.request.post('/__support/forget-investigations');
    await page.request.post('/__support/seed-investigations', { data: { count: 30, sourceId: 'banking-demo', viewEvery: 10 } });
    await page.goto('/investigations?tab=views');
    await expect(page.getByRole('button', { name: /^Open “Saved state/ }).first()).toBeVisible();
  },
  'Investigations with the Deleted view': async (page) => {
    await page.request.post('/__support/forget-investigations');
    await page.request.post('/__support/seed-investigations', { data: { count: 3, sourceId: 'banking-demo', viewEvery: 0 } });
    await page.goto('/investigations');
    await page.getByRole('button', { name: 'Actions for Case 1', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('dialog', { name: 'Delete this investigation?' }).getByRole('button', { name: 'Delete investigation' }).click();
    await page.getByRole('button', { name: 'Deleted' }).click();
    await expect(page.getByRole('button', { name: 'Restore Case 1' })).toBeVisible();
  },
  'Investigations with a delete dialog open': async (page) => {
    await page.request.post('/__support/forget-investigations');
    await page.request.post('/__support/seed-investigations', { data: { count: 3, sourceId: 'banking-demo', viewEvery: 0 } });
    await page.goto('/investigations');
    await page.getByRole('button', { name: 'Actions for Case 1', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(page.getByRole('dialog', { name: 'Delete this investigation?' })).toBeVisible();
  },
  'Investigations with the delete view dialog open': async (page) => {
    await page.request.post('/__support/forget-investigations');
    await page.request.post('/__support/seed-investigations', { data: { count: 3, sourceId: 'banking-demo', viewEvery: 1 } });
    await page.goto('/investigations?tab=views');
    await page.getByRole('button', { name: /^Delete “Saved state 1”/ }).click();
    await expect(page.getByRole('dialog', { name: /^Delete “Saved state 1” from/ })).toBeVisible();
  },
  'Investigations with the list read failed': async (page) => {
    await abort(page, (url) => url.pathname === '/v1/investigations');
    await page.goto('/investigations');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  },
  'Home with the source read failed': async (page) => {
    await abort(page, isSources);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Try again' }).first()).toBeVisible();
  },
  'Search results with results': async (page) => {
    await searchFor(page, 'AC-1');
    await expect(page.getByRole('button', { name: /^Open in graph/ }).first()).toBeVisible();
  },
  'Search results with related records': async (page) => {
    await searchFor(page, 'rel-3');
    await expect(page.getByRole('heading', { level: 2, name: /Related records/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Open in graph/ })).toHaveCount(4);
  },
  'Search results with one group failed': async (page) => {
    await searchFor(page, 'relfail-1');
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  },
  'Search results with evidence records': async (page) => {
    await searchFor(page, 'ev-3');
    await expect(page.getByRole('heading', { level: 2, name: /Evidence records/ })).toBeVisible();
  },
  'Search results with the evidence group failed': async (page) => {
    await searchFor(page, 'evfail-1');
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  },
  'Search results with an evidence relationship left out': async (page) => {
    await searchFor(page, 'evdrop-1');
    await expect(page.getByText(/^Not searched: LINKS .* · recordId: no online index$/)).toBeVisible();
  },
  'Search results with filters': async (page) => {
    await searchFor(page, 'mix-3-2');
    await expect(page.getByRole('complementary', { name: 'Filters' })).toBeVisible();
    await expect(page.getByText('5 entities')).toBeVisible();
  },
  'Search results with a capped filter count': async (page) => {
    await searchFor(page, 'many-26');
    await expect(page.getByRole('complementary', { name: 'Filters' }).getByText('≥ 25 entities · lower bound')).toBeVisible();
  },
  'Search results with more matches to show': async (page) => {
    await searchFor(page, 'many-30');
    await expect(page.getByRole('button', { name: 'Show more: Exact matches' })).toBeVisible();
  },
  'Search results with a next page no longer valid': async (page) => {
    await page.route((url) => url.pathname === '/v1/search/entities/more', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'CURSOR_INVALIDATED', message: 'This page of results is no longer valid. Start again.', retryable: false, traceId: 'tr-ux' } }) }));
    await searchFor(page, 'many-30');
    await page.getByRole('button', { name: 'Show more: Exact matches' }).click();
    await expect(page.getByRole('button', { name: 'Search again' })).toBeVisible();
  },
  'Search results with the filter counts not read': async (page) => {
    await searchFor(page, 'facfail-1');
    await expect(page.getByText('Filters unavailable: counts not read')).toBeVisible();
  },
  'Search results with a selection': async (page) => {
    await searchFor(page, 'mix-3-2');
    await page.getByRole('complementary', { name: 'Filters' }).getByRole('checkbox', { name: /Customer/ }).click();
    await expect(page.getByRole('complementary', { name: 'Filters' }).getByRole('button', { name: 'Reset' })).toBeVisible();
  },
  'Search results with no result for a selection': async (page) => {
    await searchFor(page, 'ghost-3');
    await page.getByRole('complementary', { name: 'Filters' }).getByRole('checkbox', { name: /Customer/ }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'No result for this selection' })).toBeVisible();
  },
  'Search results with no match': async (page) => {
    await searchFor(page, 'missing-1');
    await expect(page.getByText('No matching entities')).toBeVisible();
  },
  'Search results with a failed search': async (page) => {
    await abort(page, (url) => url.pathname === '/v1/search/entities');
    await searchFor(page, 'AC-1');
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  },
  'Search results with a timed-out search': async (page) => {
    await searchFor(page, `stall-${unique()}`);
    await expect(page.getByText(/timed out/i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  },
  'Search results with the sources read failed': async (page) => {
    await abort(page, isSources);
    await page.goto('/search?source=banking-demo');
    await expect(page.getByRole('button', { name: 'Try again' }).first()).toBeVisible();
  },
  'Search results with the profile read failed': async (page) => {
    await abort(page, isProfile);
    await searchFor(page, 'AC-1');
    await expect(page.getByRole('button', { name: 'Try again' }).first()).toBeVisible();
  },
  'Sources with a source open': async (page) => {
    await page.goto('/sources');
    await expect(page.getByRole('button', { name: 'Test source' })).toBeVisible();
  },
  'Sources with the sources read failed': async (page) => {
    await abort(page, isSources);
    await page.goto('/sources');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  },
  'Sources with the mapping example failed': async (page) => {
    await abort(page, isProfile);
    await page.goto('/sources');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  },
  'Explore with an entity loaded': async (page) => {
    await openEntity(page, 'banking-demo', `PX-${unique()}`);
    await expect(page.getByRole('application', { name: 'Graph canvas' })).toBeVisible();
    await page.getByRole('button', { name: 'Explore' }).click();
    await expect(page.getByRole('menu')).toBeVisible();
  },
  'Explore with the legend and the shortcut sheet open': async (page) => {
    await openEntity(page, 'banking-demo', `PY-${unique()}`);
    await expect(page.getByRole('application', { name: 'Graph canvas' })).toBeVisible();
    await page.getByRole('button', { name: /Legend/ }).first().click();
    await page.getByRole('application', { name: 'Graph canvas' }).focus();
    await page.keyboard.press(`${await modifier(page)}+/`);
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  },
  'Explore with the Search panel open': async (page) => {
    await openEntity(page, 'banking-demo', `PS-${unique()}`);
    await expect(page.getByRole('application', { name: 'Graph canvas' })).toBeVisible();
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('searchbox', { name: 'Find on canvas' })).toBeVisible();
  },
  'Explore with the Expand relationships panel open': async (page) => {
    await openEntity(page, 'banking-demo', `PE-${unique()}`);
    const canvas = page.getByRole('application', { name: 'Graph canvas' });
    await expect(canvas).toBeVisible();
    await canvas.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.keyboard.press('ContextMenu');
    await page.getByRole('menuitem', { name: 'Expand by type', exact: true }).first().click();
    await expect(page.getByRole('complementary', { name: 'Expand relationships' })).toBeVisible();
  },
  'Explore with the inspector open': async (page) => {
    await openEntity(page, 'banking-demo', `PI-${unique()}`);
    const canvas = page.getByRole('application', { name: 'Graph canvas' });
    await expect(canvas).toBeVisible();
    await canvas.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
  },
  "Explore with the Search panel's Add tab": async (page) => {
    await openAddTab(page);
    await page.getByRole('searchbox', { name: 'Find in the source' }).fill('AC-2');
    await expect(page.getByRole('button', { name: /^Add / }).first()).toBeVisible();
  },
  "Explore with the Search panel's Add tab failed": async (page) => {
    await abort(page, (url) => url.pathname === '/v1/search/entities');
    await openAddTab(page);
    await page.getByRole('searchbox', { name: 'Find in the source' }).fill('AC-2');
    await expect(page.getByRole('button', { name: 'Retry' }).first()).toBeVisible();
  },
  'Explore with its read failed': async (page) => {
    await openEntity(page, 'banking-demo', `PZ-${unique()}`);
    const path = new URL(page.url()).pathname.replace('/explore/', '/v1/investigations/');
    await abort(page, (url) => url.pathname === path);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  },
  'Explore with the investigation menu open': async (page) => {
    await openEntity(page, 'banking-demo', `PM-${unique()}`);
    await page.getByRole('button', { name: 'Investigation menu' }).click();
    await expect(page.getByRole('menuitem', { name: 'Close' })).toBeVisible();
  },
  'Explore with the rename dialog open': async (page) => {
    await openEntity(page, 'banking-demo', `PR-${unique()}`);
    await page.getByRole('button', { name: 'Investigation menu' }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await expect(page.getByRole('dialog', { name: 'Rename investigation' })).toBeVisible();
  },
  'Explore with the delete dialog open': async (page) => {
    await openEntity(page, 'banking-demo', `PD-${unique()}`);
    await page.getByRole('button', { name: 'Investigation menu' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(page.getByRole('dialog', { name: 'Delete this investigation?' })).toBeVisible();
  },
  'Explore with the delete view dialog open': async (page) => {
    await openEntity(page, 'banking-demo', `PV-${unique()}`);
    await page.getByRole('banner', { name: 'Investigation' }).getByRole('button', { name: 'Save' }).click();
    await page.getByRole('dialog', { name: 'Save investigation' }).getByLabel('Name').fill('First look');
    await page.getByRole('dialog', { name: 'Save investigation' }).getByRole('button', { name: 'Save investigation' }).click();
    await page.getByRole('banner', { name: 'Investigation' }).getByRole('button', { name: /^Views/ }).click();
    await page.getByRole('dialog', { name: /^Views/ }).getByRole('button', { name: 'Delete First look' }).click();
    await expect(page.getByRole('dialog', { name: 'Delete “First look”?' })).toBeVisible();
  },
  'Explore with a closed investigation': async (page) => {
    await openEntity(page, 'banking-demo', `PC-${unique()}`);
    await page.getByRole('button', { name: 'Investigation menu' }).click();
    await page.getByRole('menuitem', { name: 'Close' }).click();
    await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible();
  },
  'Explore with a re-pointed source': async (page) => {
    await openChangedSource(page, 'repointed');
    await expect(page.getByRole('region', { name: 'Request status' })).toContainText('This source now points to a different database.');
  },
  'Explore with a removed source': async (page) => {
    await openChangedSource(page, 'removed');
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  },
  'Explore without an investigation': async (page) => {
    await page.goto('/explore');
    await expect(page.locator('main, [role="application"]').first()).toBeVisible();
  },
  'The deep-link page failed': async (page) => {
    await abort(page, (url) => url.pathname === '/v1/investigations' && url.search === '');
    await page.goto('/banking-demo/entity/account/PD-1');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  },
  Investigations: async (page) => {
    await page.goto('/investigations');
    await expect(page.getByRole('heading', { name: 'Investigations', level: 1 })).toBeVisible();
  },
  'The not-found page': async (page) => {
    await page.goto('/no/such/page/at/all/here');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  },
};
