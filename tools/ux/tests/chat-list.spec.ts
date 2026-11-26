import { expect, test, type Page } from '@playwright/test';

const STATUS = { ask: { available: true }, summary: { available: true }, assistant: { available: true, messageWords: 1000, model: 'claude-sonnet-5-5' } };
const EMPTY = { turns: [], earlierTurns: 0, previousThreadClearedAt: null };

/** The start of the local day so many days before `now`: a chat dated there belongs to that day whatever the hour of the run. */
const day = (daysBefore: number, now: Date): string => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBefore).toISOString();
const row = (n: number, daysBefore: number, over: Record<string, unknown> = {}, now: Date = new Date()) => ({
  investigationId: `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  title: `Chat title ${n}`,
  caseRef: null,
  sourceId: 'banking-demo',
  sourceAlias: 'banking-demo',
  sourceState: 'available',
  lastQuestionAt: day(daysBefore, now),
  turns: 1,
  lastQuestion: `The last question of chat ${n}`,
  lastQuestionCut: false,
  ...over,
});
const chatsAt = (now: Date) => [row(1, 0, {}, now), row(2, 0, {}, now), row(3, 3, {}, now), row(4, 4, {}, now), row(5, 30, {}, now), row(6, 40, { sourceState: 'removed' }, now)];
const CHATS = chatsAt(new Date());

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
    await expect(page.getByRole('list', { name: 'Today' })).toBeVisible();
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

  test('reads the list again when the pointer enters the column after a chat was cleared in another tab, with no click and with no window event (a browser tab switch may send none)', async ({ context }) => {
    let chats = [...CHATS];
    const wire = async (page: Page): Promise<void> => {
      await page.route((url) => url.pathname === '/v1/ai/status', (route) => route.fulfill({ json: STATUS }));
      await page.route((url) => /^\/v1\/assistant\/investigations\/[^/]+\/thread$/.test(url.pathname), (route) => route.fulfill({ json: EMPTY }));
      await page.route((url) => url.pathname === '/v1/assistant/threads', (route) => route.fulfill({ json: { items: chats, nextCursor: null } }));
    };
    const first = await context.newPage();
    await wire(first);
    await openPage(first);
    await expect(first.getByRole('link', { name: /Chat title 3/ })).toBeVisible();
    const second = await context.newPage();
    await wire(second);
    await openPage(second);
    await second.bringToFront();
    chats = chats.filter((chat) => !chat.title.endsWith('3'));
    await first.bringToFront();
    await first.waitForTimeout(3200);
    await first.locator('.chat-list').hover();
    await expect(first.getByRole('link', { name: /Chat title 3/ })).toHaveCount(0);
  });

  const justAfterMidnight = (): Date => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 30);
  };
  for (const [when, clock] of [['at the hour of the run', undefined], ['half an hour after midnight', justAfterMidnight]] as const) {
    test(`names a list for each group, so the rows are announced as list items, ${when}`, async ({ page }) => {
      const now = clock?.();
      if (now !== undefined) await page.clock.setFixedTime(now);
      await routes(page, [{ items: now === undefined ? CHATS : chatsAt(now), nextCursor: null }]);
      await openPage(page);
      await expect(page.getByRole('list', { name: 'Today' }).getByRole('listitem')).toHaveCount(3);
      await expect(page.getByRole('list', { name: 'Previous 7 days' }).getByRole('listitem')).toHaveCount(2);
      await expect(page.getByRole('list', { name: 'Older' }).getByRole('listitem')).toHaveCount(2);
    });
  }

  test('moves the focus to the first new row after Show more by the keyboard, and does not scroll a pointer away', async ({ page }) => {
    await routes(page, [{ items: CHATS.slice(0, 2), nextCursor: '1' }, { items: CHATS.slice(2), nextCursor: null }]);
    await openPage(page);
    await page.getByRole('button', { name: 'Show more' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('link', { name: /Chat title 3/ })).toBeFocused();
  });

  test('keeps the pages that were loaded when a search is cleared', async ({ page }) => {
    await routes(page, [{ items: CHATS.slice(0, 2), nextCursor: '1' }, { items: CHATS.slice(2), nextCursor: null }]);
    await openPage(page);
    await page.getByRole('button', { name: 'Show more' }).click();
    await expect(page.getByRole('link', { name: /Chat title 6/ })).toBeVisible();
    const field = page.getByRole('searchbox', { name: 'Search chats' });
    await field.fill('title 5');
    await expect(page.getByRole('link', { name: /Chat title 6/ })).toHaveCount(0);
    await field.fill('');
    await expect(page.getByRole('link', { name: /Chat title 6/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);
  });

  test('says "Loading chats…" while the list is read, then shows it', async ({ page }) => {
    await page.route((url) => url.pathname === '/v1/ai/status', (route) => route.fulfill({ json: STATUS }));
    await page.route((url) => /^\/v1\/assistant\/investigations\/[^/]+\/thread$/.test(url.pathname), (route) => route.fulfill({ json: EMPTY }));
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route((url) => url.pathname === '/v1/assistant/threads', async (route) => {
      await held;
      await route.fulfill({ json: { items: CHATS, nextCursor: null } });
    });
    await openPage(page);
    await expect(page.getByRole('status').filter({ hasText: 'Loading chats…' })).toBeVisible();
    release();
    await expect(page.getByRole('link', { name: /Chat title 1/ })).toBeVisible();
    await expect(page.getByText('Loading chats…')).toHaveCount(0);
  });

  test('says the server could not be reached in a sentence, and Try again brings the list back', async ({ page }) => {
    await page.route((url) => url.pathname === '/v1/ai/status', (route) => route.fulfill({ json: STATUS }));
    await page.route((url) => /^\/v1\/assistant\/investigations\/[^/]+\/thread$/.test(url.pathname), (route) => route.fulfill({ json: EMPTY }));
    let down = true;
    await page.route((url) => url.pathname === '/v1/assistant/threads', (route) => (down ? route.abort('connectionrefused') : route.fulfill({ json: { items: CHATS, nextCursor: null } })));
    await openPage(page);
    await expect(page.locator('.chat-list-failure').getByRole('alert')).toHaveText('The server could not be reached.');
    await expect(page.getByText('NETWORK_UNAVAILABLE')).toHaveCount(0);
    down = false;
    await page.getByRole('button', { name: 'Try again to load the chats' }).click();
    await expect(page.getByRole('link', { name: /Chat title 1/ })).toBeVisible();
    await expect(page.locator('.chat-list-failure')).toHaveCount(0);
  });

  test('shows the full title and question of a row whose text is cut, on hover and on focus, and no tip on a row that fits', async ({ page }) => {
    const long = 'A question that is long enough to be cut by the ellipsis of the row because it has far more words than the column has room for';
    const chats = [row(1, 0, { lastQuestion: long }), row(2, 0, { lastQuestion: 'Short one' })];
    await routes(page, [{ items: chats, nextCursor: null }]);
    await openPage(page);
    const tip = page.locator('.assistant-table-tip');
    await page.getByRole('link', { name: /Chat title 2/ }).hover();
    await expect(tip).toHaveCount(0);
    await page.getByRole('link', { name: /Chat title 1/ }).hover();
    await expect(tip).toContainText(long);
    await expect(tip).toContainText('Chat title 1');
    await page.mouse.move(700, 400);
    await expect(tip).toHaveCount(0);
    await page.getByRole('link', { name: /Chat title 2/ }).focus();
    await expect(tip).toHaveCount(0);
    await page.keyboard.press('ArrowUp');
    await expect(tip).toContainText(long);
    await page.keyboard.press('Escape');
    await expect(tip).toHaveCount(0);
  });

  test('gives each group list the accessible name of its group, as the browser computes it', async ({ page }) => {
    await routes(page);
    await openPage(page);
    await expect(page.getByRole('list', { name: 'Today' })).toBeVisible();
    await expect(page.locator('.chat-list-body').getByRole('list')).toHaveCount(3);
    const cdp = await page.context().newCDPSession(page);
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const names = nodes.filter((node) => node.role?.value === 'list').map((node) => String(node.name?.value ?? '')).filter((name) => name !== '');
    expect(names).toEqual(['Today', 'Previous 7 days', 'Older']);
  });

  test('ends the second line and the tip with an ellipsis when the server cut the stored question, at a word of the stored text', async ({ page }) => {
    const cutText = 'Please look at this customer and tell me which accounts they hold and whether any o';
    await routes(page, [{ items: [row(1, 0, { lastQuestion: cutText, lastQuestionCut: true }), row(2, 0, { lastQuestion: 'A whole question that is long enough to be cut by the ellipsis of the row only because of the width', lastQuestionCut: false })], nextCursor: null }]);
    await openPage(page);
    await expect(page.getByRole('link', { name: /Chat title 1/ }).locator('.chat-list-row-question')).toHaveText(`${cutText}…`);
    await expect(page.getByRole('link', { name: /Chat title 2/ }).locator('.chat-list-row-question')).not.toContainText('…');
    await page.getByRole('link', { name: /Chat title 1/ }).hover();
    await expect(page.locator('.assistant-table-tip')).toContainText(`${cutText}…`);
  });

  const manyChats = Array.from({ length: 33 }, (_, index) => row(index + 1, index < 10 ? 0 : index < 20 ? 3 : 30));
  const pagedRoutes = (page: Page) => routes(page, [{ items: manyChats.slice(0, 25), nextCursor: '1' }, { items: manyChats.slice(25), nextCursor: null }]);
  const focusedRow = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest('.chat-list-row')?.querySelector('.chat-list-row-name')?.textContent ?? `none:${document.activeElement?.tagName}`);

  for (const how of ['mouse click', 'Enter']) {
    for (const waited of [false, true]) {
      test(`moves the focus to the first new row after Show more on the last page by ${how}${waited ? ', after the list was read longer ago than the refresh limit' : ''}`, async ({ page }) => {
        await pagedRoutes(page);
        await openPage(page);
        const more = page.getByRole('button', { name: 'Show more' });
        await expect(more).toBeVisible();
        if (waited) await page.waitForTimeout(3400);
        if (how === 'Enter') {
          await more.focus();
          await page.keyboard.press('Enter');
        } else {
          await more.click();
        }
        await expect(page.getByRole('link', { name: /Chat title 26/ })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);
        await expect.poll(() => focusedRow(page)).toBe('Chat title 26');
      });
    }
  }
});
