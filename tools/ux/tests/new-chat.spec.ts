import { expect, test, type Page } from '@playwright/test';

const STATUS = { ask: { available: true }, summary: { available: true }, assistant: { available: true, messageWords: 1000, model: 'claude-sonnet-5-5' } };
const EMPTY = { turns: [], earlierTurns: 0, previousThreadClearedAt: null };

const idOf = (n: number): string => `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const investigation = (n: number, over: Record<string, unknown> = {}) => ({
  id: idOf(n),
  sourceId: 'banking-demo',
  title: `Open investigation ${n}`,
  caseRef: `REF-2026-${1040 + n}`,
  status: 'open',
  startingEntity: { entityType: 'account', stableId: `AC-${n}` },
  sourceState: 'available',
  createdAt: '2026-11-05T10:00:00.000Z',
  lastEditedAt: '2026-11-05T10:00:00.000Z',
  version: 1,
  sourceAlias: 'banking-demo',
  save: { state: 'unsaved', savedAt: null },
  nodeCount: 1,
  edgeCount: 0,
  ...over,
});
const OPEN = [investigation(11), investigation(12), investigation(13), investigation(14, { sourceState: 'removed' }), investigation(15, { sourceState: 'repointed' }), investigation(16)];
const WITH_CHAT = [idOf(11), idOf(12), idOf(15)];

function listBody(items: readonly unknown[]) {
  return {
    items,
    nextCursor: null,
    retention: { deletedInvestigationsDays: 30 },
    matching: { value: items.length, quality: 'exact', scope: 'investigations-matching' },
    counts: { investigations: { value: items.length, quality: 'exact', scope: 'investigations' }, sources: { value: 1, quality: 'exact', scope: 'investigation-sources' }, savedViews: { count: { value: 0, quality: 'exact', scope: 'named-views' }, lastEditedAt: null } },
  };
}

interface Asked {
  readonly lists: URLSearchParams[];
  readonly lookups: string[][];
}

async function routes(page: Page): Promise<Asked> {
  const asked: Asked = { lists: [], lookups: [] };
  await page.route((url) => url.pathname === '/v1/ai/status', (route) => route.fulfill({ json: STATUS }));
  await page.route((url) => /^\/v1\/assistant\/investigations\/[^/]+\/thread$/.test(url.pathname), (route) => route.fulfill({ json: EMPTY }));
  await page.route((url) => url.pathname === '/v1/assistant/threads', (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
  await page.route((url) => url.pathname === '/v1/assistant/threads/lookup', (route) => {
    const ids = (route.request().postDataJSON() as { investigationIds: string[] }).investigationIds;
    asked.lookups.push(ids);
    return route.fulfill({ json: { withChat: ids.filter((id) => WITH_CHAT.includes(id)) } });
  });
  await page.route((url) => url.pathname === '/v1/investigations' && url.searchParams.get('status') === 'open', (route) => {
    const url = new URL(route.request().url());
    asked.lists.push(url.searchParams);
    const text = url.searchParams.get('q')?.toLowerCase();
    return route.fulfill({ json: listBody(text === undefined ? OPEN : OPEN.filter((row) => row.title.toLowerCase().includes(text))) });
  });
  return asked;
}

async function openPage(page: Page): Promise<void> {
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
  await page.getByRole('navigation').getByRole('link', { name: 'Home' }).click();
  await page.getByRole('link', { name: 'Assistant' }).click();
  await expect(page).toHaveURL(/\/assistant\/[0-9a-f-]{36}$/);
}

const picker = (page: Page) => page.getByRole('dialog', { name: 'New chat about…' });
const box = async (locator: ReturnType<Page['locator']>) => {
  const found = await locator.boundingBox();
  if (found === null) throw new Error('not drawn');
  return found;
};

test.describe('The picker of a new chat on the Assistant page', () => {
  test('opens under the New chat button as the frame draws it: 400 px wide, 12 px under the button, white with its border and shadow, and moves nothing of the page', async ({ page }) => {
    await routes(page);
    await openPage(page);
    const button = page.getByRole('button', { name: 'New chat' });
    const before = await box(page.locator('.assistant-page-thread'));
    await button.click();
    await expect(picker(page)).toBeVisible();
    await expect(picker(page).getByRole('option')).toHaveCount(6);
    const buttonBox = await box(button);
    const card = await box(picker(page));
    expect([card.x, card.width, Math.round(card.y - (buttonBox.y + buttonBox.height))]).toEqual([buttonBox.x, 400, 12]);
    const style = await picker(page).evaluate((element) => {
      const computed = getComputedStyle(element);
      return { background: computed.backgroundColor, border: computed.borderTopColor, width: computed.borderTopWidth, radius: computed.borderTopLeftRadius, shadow: computed.boxShadow !== 'none' };
    });
    expect(style).toEqual({ background: 'rgb(255, 255, 255)', border: 'rgb(202, 208, 218)', width: '1px', radius: '8px', shadow: true });
    expect(await box(page.locator('.assistant-page-thread'))).toEqual(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('draws the chips: "Has a chat" for the investigations that have one, the source chip of a gone source (both for one that has a chat), and "Start chat" on the pointed row', async ({ page }) => {
    const asked = await routes(page);
    await openPage(page);
    await page.getByRole('button', { name: 'New chat' }).click();
    const rows = picker(page).getByRole('option');
    await expect(rows.nth(0).locator('.new-chat-chip')).toHaveText(['Has a chat']);
    await expect(rows.nth(3).locator('.new-chat-chip')).toHaveText(['Source removed']);
    await expect(rows.nth(4).locator('.new-chat-chip')).toHaveText(['Has a chat', 'Source re-pointed']);
    await expect(rows.nth(3)).toHaveAttribute('aria-disabled', 'true');
    await expect(rows.nth(4)).not.toHaveAttribute('aria-disabled', 'true');
    await expect(rows.nth(2).locator('.new-chat-start')).toBeHidden();
    await rows.nth(2).hover();
    await expect(rows.nth(2).locator('.new-chat-start')).toHaveText('Start chat ▸');
    expect(asked.lookups).toHaveLength(1);
    const gone = await rows.nth(3).locator('.new-chat-chip').evaluate((element) => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color }));
    expect(gone).toEqual({ background: 'rgb(255, 243, 215)', color: 'rgb(153, 97, 13)' });
  });

  test('searches the open investigations, picks one with the keyboard, and goes to its chat', async ({ page }) => {
    const asked = await routes(page);
    await openPage(page);
    await page.getByRole('button', { name: 'New chat' }).click();
    await expect(picker(page).getByRole('option')).toHaveCount(6);
    await expect(page.getByRole('combobox', { name: 'Search open investigations' })).toBeFocused();
    await page.keyboard.type('investigation 13');
    await expect(picker(page).getByRole('option')).toHaveCount(1);
    expect(asked.lists.at(-1)?.get('q')).toBe('investigation 13');
    await page.keyboard.press('ArrowDown');
    const fill = await picker(page).getByRole('option').evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(fill).toBe('rgb(234, 237, 247)');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/assistant/${idOf(13)}$`));
    await expect(picker(page)).toHaveCount(0);
  });

  test('stays inside the window with a long list: the card ends above the bottom edge, the rows scroll inside it and the footer stays in view', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await routes(page);
    await page.unroute((url) => url.pathname === '/v1/investigations' && url.searchParams.get('status') === 'open');
    const many = Array.from({ length: 25 }, (_, index) => investigation(100 + index));
    await page.route((url) => url.pathname === '/v1/investigations' && url.searchParams.get('status') === 'open', (route) => route.fulfill({ json: listBody(many) }));
    await openPage(page);
    await page.getByRole('button', { name: 'New chat' }).click();
    await expect(picker(page).getByRole('option')).toHaveCount(25);
    const card = await box(picker(page));
    expect(card.y + card.height).toBeLessThanOrEqual(600);
    const footer = await box(picker(page).locator('.new-chat-footer'));
    expect(footer.y + footer.height).toBeLessThanOrEqual(600);
    expect(await picker(page).locator('.new-chat-rows').evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('does not start a chat on a gone source that has none, closes on Escape with the focus on the button, and never scrolls the page sideways', async ({ page }) => {
    await routes(page);
    await openPage(page);
    const button = page.getByRole('button', { name: 'New chat' });
    await button.click();
    await expect(picker(page).getByRole('option')).toHaveCount(6);
    const url = page.url();
    // the row says it is disabled, so the click is forced: what is proved is that it does nothing
    await picker(page).getByRole('option').nth(3).click({ force: true });
    await expect(picker(page)).toBeVisible();
    expect(page.url()).toBe(url);
    await page.keyboard.press('Escape');
    await expect(picker(page)).toHaveCount(0);
    await expect(button).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
