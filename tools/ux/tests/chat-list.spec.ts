import { expect, test, type Page } from '@playwright/test';

const STATUS = { ask: { available: true }, summary: { available: true }, assistant: { available: true, messageWords: 1000, model: 'claude-sonnet-5-5' } };
const EMPTY = { turns: [], earlierTurns: 0, previousThreadClearedAt: null };

const day = (daysBefore: number): string => new Date(Date.now() - daysBefore * 86_400_000 - 3_600_000).toISOString();
const row = (n: number, daysBefore: number, over: Record<string, unknown> = {}) => ({
  investigationId: `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  title: `Chat title ${n}`,
  caseRef: null,
  sourceId: 'banking-demo',
  sourceAlias: 'banking-demo',
  sourceState: 'available',
  lastQuestionAt: day(daysBefore),
  turns: 1,
  lastQuestion: `The last question of chat ${n}`,
  ...over,
});
const CHATS = [row(1, 0), row(2, 0), row(3, 3), row(4, 4), row(5, 30), row(6, 40, { sourceState: 'removed' })];

async function routes(page: Page, pages: readonly { readonly items: readonly unknown[]; readonly nextCursor: string | null }[] = [{ items: CHATS, nextCursor: null }], asked: string[] = []): Promise<void> {
  await page.route((url) => url.pathname === '/v1/ai/status', (route) => route.fulfill({ json: STATUS }));
  await page.route((url) => /^\/v1\/assistant\/investigations\/[^/]+\/thread$/.test(url.pathname), (route) => route.fulfill({ json: EMPTY }));
  await page.route((url) => url.pathname === '/v1/assistant/threads', (route) => {
    const url = new URL(route.request().url());
    asked.push(url.search);
    const at = url.searchParams.get('cursor') === null ? 0 : Number(url.searchParams.get('cursor'));
    const found = url.searchParams.get('q') === null ? pages[at] : { items: CHATS.filter((chat) => chat.title.includes(url.searchParams.get('q') ?? '')), nextCursor: null };
    return route.fulfill({ json: found ?? { items: [], nextCursor: null } });
  });
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

const box = async (page: Page, selector: string) => {
  const found = await page.locator(selector).first().boundingBox();
  if (found === null) throw new Error(`${selector} is not drawn`);
  return found;
};

test.describe('The chat list column of the Assistant page', () => {
  test('is drawn as the frame draws it: a 288 px column beside the sidebar with New chat, the search, the groups, the rows and the footnote', async ({ page }) => {
    await routes(page);
    await openPage(page);
    await expect(page.getByRole('region', { name: 'Today' })).toBeVisible();
    const sidebar = await box(page, '.sidebar');
    const column = await box(page, '.chat-list');
    expect(column.x).toBe(sidebar.x + sidebar.width);
    expect(column.width).toBe(288);
    expect(column.y).toBe(sidebar.y);
    const style = await page.locator('.chat-list').evaluate((element) => {
      const computed = getComputedStyle(element);
      return { background: computed.backgroundColor, rule: computed.borderRightColor, rulewidth: computed.borderRightWidth };
    });
    expect(style).toEqual({ background: 'rgb(250, 251, 252)', rule: 'rgb(227, 230, 236)', rulewidth: '1px' });
    const newChat = await box(page, '.chat-list-new');
    expect([newChat.x - column.x, newChat.y - column.y, newChat.width, newChat.height]).toEqual([16, 16, 255, 32]);
    const search = await box(page, '.chat-list-search');
    expect([search.x - column.x, search.y - column.y, search.width, search.height]).toEqual([16, 60, 255, 34]);
    const today = await box(page, '.chat-list-group h2');
    expect(today.y - column.y).toBe(106);
    const first = await box(page, '.chat-list-row');
    expect([first.x - column.x, first.y - column.y, first.width, first.height]).toEqual([16, 137, 255, 49]);
    const heading = await page.locator('.chat-list-group h2').first().evaluate((element) => getComputedStyle(element).textTransform);
    expect(heading).toBe('uppercase');
    const note = await box(page, '.chat-list-foot');
    expect(Math.abs(note.y + note.height - (column.y + column.height - 16))).toBeLessThanOrEqual(2);
    const thread = await box(page, '.assistant-page-thread');
    expect(thread.x).toBe(column.x + column.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('selects the chat of the shown investigation, opens another chat by a click, and draws the pill of a removed source on its own row', async ({ page }) => {
    await routes(page);
    await openPage(page);
    await expect(page.getByRole('link', { name: /Chat title 1/ })).toBeVisible();
    await expect(page.locator('.chat-list-chip')).toHaveCount(1);
    await expect(page.getByRole('link', { name: /Chat title 6/ }).locator('.chat-list-chip')).toHaveText('Source removed');
    await page.getByRole('link', { name: /Chat title 3/ }).click();
    await expect(page).toHaveURL(/\/assistant\/0192f000-0000-7000-8000-000000000003$/);
  });

  test('is reached by keyboard: the search field first, then the rows, with the arrow keys between them', async ({ page }) => {
    await routes(page);
    await openPage(page);
    await page.getByRole('searchbox', { name: 'Search chats' }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: /Chat title 1/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('link', { name: /Chat title 2/ })).toBeFocused();
  });

  test('narrows the list by the search, says when nothing matches, and Escape shows the list again', async ({ page }) => {
    await routes(page);
    await openPage(page);
    const field = page.getByRole('searchbox', { name: 'Search chats' });
    await field.fill('title 5');
    await expect(page.getByRole('link')).toHaveCount(1 + (await page.locator('.sidebar a').count()) + (await page.locator('.assistant-page-head a').count()));
    await field.fill('nothing like it');
    await expect(page.getByText('No chats match your search.')).toBeVisible();
    await field.press('Escape');
    await expect(page.getByRole('link', { name: /Chat title 1/ })).toBeVisible();
  });

  test('reads the next page by Show more and keeps the groups under one heading each', async ({ page }) => {
    const asked: string[] = [];
    await routes(page, [{ items: CHATS.slice(0, 2), nextCursor: '1' }, { items: CHATS.slice(2), nextCursor: null }], asked);
    await openPage(page);
    await page.getByRole('button', { name: 'Show more' }).click();
    await expect(page.getByRole('link', { name: /Chat title 6/ })).toBeVisible();
    await expect(page.locator('.chat-list-group h2')).toHaveText(['Today', 'Previous 7 days', 'Older']);
    expect(asked.some((search) => search.includes('cursor=1'))).toBe(true);
    await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);
  });
});
