import { expect, test, type Page } from '@playwright/test';
import type { AssistantTurnAnswer } from '@neburyx/contracts';
import { canvasOf } from './support/workspace.ts';

const panel = (page: Page) => page.locator('.assistant-panel');
const floatingBox = (page: Page) => page.locator('.floating-panel', { has: page.locator('.assistant-panel') });
const wideButton = (page: Page) => panel(page).getByRole('button', { name: /^(Wide|Normal width|Wide: close the inspector first.*)$/ });
const widthOf = async (page: Page): Promise<number> => (await floatingBox(page).boundingBox())?.width ?? 0;
const windowWidth = (page: Page): number => page.viewportSize()?.width ?? 0;
const limitOf = (page: Page): number => Math.floor(0.6 * windowWidth(page));

async function openWorkspace(page: Page): Promise<void> {
  await page.route((url) => /^\/v1\/assistant\/investigations\/[^/]+\/thread$/.test(url.pathname), (route) => route.fulfill({ json: { turns: [], earlierTurns: 0, previousThreadClearedAt: null } }));
  await page.route((url) => url.pathname === '/v1/ai/status', (route) => route.fulfill({ json: { ask: { available: true }, summary: { available: true }, assistant: { available: true, messageWords: 1000, model: 'claude-sonnet-5-5' } } }));
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
  await page.getByRole('banner', { name: 'Investigation' }).getByRole('button', { name: 'Assistant' }).click();
  await expect(panel(page)).toBeVisible();
}

async function answerWithTable(page: Page): Promise<void> {
  const cited = { sourceId: 'banking-demo', entityType: 'account', stableId: 'AC-1' };
  const answer: AssistantTurnAnswer = {
    status: 'answered',
    route: 'view',
    blocks: [{ kind: 'table', table: { title: 'Accounts · 6 rows', columns: ['Element', 'A rather long column label to widen it', 'Another long column label'], rows: Array.from({ length: 6 }, (_, index) => ({ cells: [`row-${index + 1}`, `a long cell text for row ${index + 1} of the table`, 'value'], cites: ['n1'] })), note: 'Each row selects its elements on the graph.' } }],
    citations: [{ key: 'n1', kind: 'entity', ref: cited }],
    coverage: { retrieval: '1 shown · 0 not yet retrieved (exact)', summary: '6 accounts in view shown · exact' },
    model: 'claude-sonnet-5-5',
    calls: 2,
  };
  await page.route((url) => url.pathname === '/v1/assistant/turns', (route) => route.fulfill({ json: answer }));
  await page.getByLabel('Your message').fill('show them as a table');
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('table', { name: 'Accounts · 6 rows' })).toBeVisible();
}

async function answerWithStamps(page: Page): Promise<void> {
  const cited = { sourceId: 'banking-demo', entityType: 'account', stableId: 'AC-1' };
  const rows = Array.from({ length: 3 }, (_, index) => ({ cells: [`Transaction TX-00485633${index}`, `${1664 + index}.72`, index % 2 === 0 ? 'cash machine' : 'night deposit', `2022-09-09T23:5${index}:00Z`], cites: ['n1'] }));
  const answer: AssistantTurnAnswer = {
    status: 'answered',
    route: 'view',
    blocks: [{ kind: 'table', table: { title: 'Transactions · 3 rows', columns: ['Transaction', 'Amount', 'Channel', 'Timestamp'], rows, note: 'Each row selects its elements on the graph.' } }],
    citations: [{ key: 'n1', kind: 'entity', ref: cited }],
    coverage: { retrieval: '1 shown · 0 not yet retrieved (exact)', summary: '3 transactions in view shown · exact' },
    model: 'claude-sonnet-5-5',
    calls: 2,
  };
  await page.route((url) => url.pathname === '/v1/assistant/turns', (route) => route.fulfill({ json: answer }));
  await page.getByLabel('Your message').fill('show them as a table');
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('table', { name: 'Transactions · 3 rows' })).toBeVisible();
}

async function answerWithList(page: Page): Promise<void> {
  const cited = { sourceId: 'banking-demo', entityType: 'account', stableId: 'AC-1' };
  const answer: AssistantTurnAnswer = {
    status: 'answered',
    route: 'view',
    blocks: [{ kind: 'list', label: 'Where it came from', items: [{ text: `Owner: ${'a rather long item that wraps '.repeat(6)}and ends.`, cites: ['n1'] }, { text: 'Bank: another item.', cites: ['n1'] }] }],
    citations: [{ key: 'n1', kind: 'entity', ref: cited }],
    coverage: { retrieval: '1 shown · 0 not yet retrieved (exact)', summary: 'The answer cites 1 of the 1 shown elements.' },
    model: 'claude-sonnet-5-5',
    calls: 2,
  };
  await page.route((url) => url.pathname === '/v1/assistant/turns', (route) => route.fulfill({ json: answer }));
  await page.getByLabel('Your message').fill('show where it came from');
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('list', { name: 'Where it came from' })).toBeVisible();
}

test.describe('the wide Assistant panel', () => {
  test('goes wide with the keyboard to 60% of the window, 16 px from the window edge, and back to its opening width', async ({ page }) => {
    await openWorkspace(page);
    expect(await widthOf(page)).toBe(380);
    await wideButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(wideButton(page)).toHaveAttribute('aria-pressed', 'true');
    expect(await widthOf(page)).toBe(limitOf(page));
    const box = await floatingBox(page).boundingBox();
    expect(Math.round(windowWidth(page) - ((box?.x ?? 0) + (box?.width ?? 0)))).toBe(16);
    await page.keyboard.press('Space');
    await expect(wideButton(page)).toHaveAttribute('aria-pressed', 'false');
    expect(await widthOf(page)).toBe(380);
    await expect(wideButton(page)).toBeFocused();
  });

  test('stays at 60% of the window while wide, narrower and then wider than the window it was pressed in', async ({ page }) => {
    await openWorkspace(page);
    await wideButton(page).click();
    for (const width of [1000, 1700]) {
      await page.setViewportSize({ width, height: page.viewportSize()?.height ?? 720 });
      await expect.poll(() => widthOf(page)).toBe(Math.floor(0.6 * width));
      await expect(wideButton(page)).toHaveAttribute('aria-pressed', 'true');
    }
  });

  test('keeps the canvas hint off the wide panel: inside the free area, 16 px left of the panel, clear of the tool strip and the scope lines, with the panel header uncovered', async ({ page }) => {
    await openWorkspace(page);
    await wideButton(page).click();
    const hint = page.locator('.starting-hint');
    await expect(hint).toBeVisible();
    const hintBox = await hint.boundingBox();
    const panelBox = await floatingBox(page).boundingBox();
    const stripBox = await page.locator('.region-tool-strip').boundingBox();
    const scopeBox = await page.locator('.graph-scope').boundingBox();
    expect((hintBox?.x ?? 0) + (hintBox?.width ?? 0)).toBeLessThanOrEqual((panelBox?.x ?? 0) - 16 + 0.5);
    expect(hintBox?.x ?? 0).toBeGreaterThanOrEqual((stripBox?.x ?? 0) + (stripBox?.width ?? 0));
    const overlapsScope = (hintBox?.x ?? 0) < (scopeBox?.x ?? 0) + (scopeBox?.width ?? 0) && (scopeBox?.x ?? 0) < (hintBox?.x ?? 0) + (hintBox?.width ?? 0) && (hintBox?.y ?? 0) < (scopeBox?.y ?? 0) + (scopeBox?.height ?? 0) && (scopeBox?.y ?? 0) < (hintBox?.y ?? 0) + (hintBox?.height ?? 0);
    expect(overlapsScope).toBe(false);
    const heading = await panel(page).getByRole('heading', { name: 'Assistant' }).boundingBox();
    const topmost = await page.evaluate(([x, y]) => document.elementFromPoint(x ?? 0, y ?? 0)?.closest('.assistant-panel') !== null, [(heading?.x ?? 0) + 4, (heading?.y ?? 0) + 4]);
    expect(topmost).toBe(true);
  });

  test('keeps the canvas hint clear of an open Search panel and of the panel at its opening width, and draws none once the wide panel leaves no room', async ({ page }) => {
    await openWorkspace(page);
    await page.getByRole('button', { name: 'Search', exact: true }).first().click();
    const search = page.locator('.floating-panel[aria-label="Search"]');
    await expect(search).toBeVisible();
    const hint = page.locator('.starting-hint');
    await expect(hint).toBeVisible();
    const hintBox = await hint.boundingBox();
    const searchBox = await search.boundingBox();
    const panelBox = await floatingBox(page).boundingBox();
    expect(hintBox?.x ?? 0).toBeGreaterThanOrEqual((searchBox?.x ?? 0) + (searchBox?.width ?? 0));
    expect((hintBox?.x ?? 0) + (hintBox?.width ?? 0)).toBeLessThanOrEqual((panelBox?.x ?? 0) - 16 + 0.5);
    const topmost = await page.evaluate(([x, y]) => document.elementFromPoint(x ?? 0, y ?? 0)?.closest('.floating-panel')?.getAttribute('aria-label'), [(searchBox?.x ?? 0) + 20, (searchBox?.y ?? 0) + 12]);
    expect(topmost).toBe('Search');
    await wideButton(page).click();
    await expect(hint).toBeHidden();
  });

  test('draws no hint at a 1000 px window with the Search panel open and the Assistant wide, and leaves both panel headers uncovered', async ({ page }) => {
    await openWorkspace(page);
    await wideButton(page).click();
    await page.getByRole('button', { name: 'Search', exact: true }).first().click();
    await page.setViewportSize({ width: 1000, height: 720 });
    await expect(page.locator('.floating-panel[aria-label="Search"]')).toBeVisible();
    await expect(page.locator('.starting-hint')).toBeHidden();
    const topmost = async (selector: string): Promise<string | null | undefined> => {
      const box = await page.locator(selector).boundingBox();
      return page.evaluate(([x, y]) => document.elementFromPoint(x ?? 0, y ?? 0)?.closest('.floating-panel')?.getAttribute('aria-label'), [(box?.x ?? 0) + 20, (box?.y ?? 0) + 12]);
    };
    expect(await topmost('.floating-panel[aria-label="Search"]')).toBe('Search');
    expect(await topmost('.floating-panel[aria-label="Assistant"]')).toBe('Assistant');
  });

  test('starts the inspector beside the Assistant, which returned to its normal width, 16 px below the scope lines when they overlap it, also with a long scope line', async ({ page }) => {
    await openWorkspace(page);
    await answerWithTable(page);
    await wideButton(page).click();
    await panel(page).getByRole('button', { name: /^Citation 1, / }).first().click();
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await expect(inspector).toBeVisible();
    // the Assistant went back to its normal width when the inspector opened
    await expect(wideButton(page)).toHaveAttribute('aria-pressed', 'false');
    const boxes = async () => ({ inspector: await inspector.boundingBox(), scope: await page.locator('.graph-scope').boundingBox(), panel: await floatingBox(page).boundingBox() });
    const apart = (a: { x: number; y: number; width: number; height: number } | null, b: { x: number; y: number; width: number; height: number } | null): boolean => a === null || b === null || a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
    let found = await boxes();
    expect(apart(found.inspector, found.scope)).toBe(true);
    expect(Math.round((found.panel?.x ?? 0) - ((found.inspector?.x ?? 0) + (found.inspector?.width ?? 0)))).toBe(16);
    await page.locator('.graph-scope').evaluate((element) => {
      const line = document.createElement('p');
      line.textContent = 'a long scope line that goes on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on';
      element.appendChild(line);
    });
    await expect.poll(async () => apart((await boxes()).inspector, (await boxes()).scope)).toBe(true);
    found = await boxes();
    expect(Math.round((found.inspector?.y ?? 0) - ((found.scope?.y ?? 0) + (found.scope?.height ?? 0)))).toBeGreaterThanOrEqual(16);
    expect(Math.round((found.panel?.x ?? 0) - ((found.inspector?.x ?? 0) + (found.inspector?.width ?? 0)))).toBe(16);
  });

  test('stops a drag of the left edge at 60% of the window, where the button shows wide', async ({ page }) => {
    await openWorkspace(page);
    const handle = await panel(page).locator('xpath=ancestor::*[contains(@class,"panel-frame")]').getByRole('separator').boundingBox();
    const x = (handle?.x ?? 0) + (handle?.width ?? 0) / 2;
    const y = (handle?.y ?? 0) + 120;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(40, y, { steps: 12 });
    await page.mouse.up();
    expect(await widthOf(page)).toBe(limitOf(page));
    await expect(wideButton(page)).toHaveAttribute('aria-pressed', 'true');
  });

  test('tints the button while wide and shows a focus ring on it', async ({ page }) => {
    await openWorkspace(page);
    const tint = (): Promise<string> => wideButton(page).evaluate((element) => getComputedStyle(element).backgroundColor);
    const normal = await tint();
    await wideButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(wideButton(page)).toHaveAttribute('aria-pressed', 'true');
    expect(await tint()).not.toBe(normal);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    expect(await wideButton(page).evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none');
  });

  test('gives a table the whole width of the card, without sideways scrolling, and keeps the inspector beside the panel, which returns to its normal width, without overlap', async ({ page }) => {
    await openWorkspace(page);
    await answerWithTable(page);
    await wideButton(page).click();
    const scroll = panel(page).locator('.assistant-table-scroll');
    expect(await scroll.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const tableBox = await panel(page).getByRole('table').boundingBox();
    const scrollBox = await scroll.boundingBox();
    expect(Math.abs((tableBox?.width ?? 0) - (scrollBox?.width ?? 1))).toBeLessThanOrEqual(2);
    await panel(page).getByRole('button', { name: /^Citation 1, / }).first().click();
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await expect(inspector).toBeVisible();
    const inspectorBox = await inspector.boundingBox();
    const panelBox = await floatingBox(page).boundingBox();
    expect(Math.round((panelBox?.x ?? 0) - ((inspectorBox?.x ?? 0) + (inspectorBox?.width ?? 0)))).toBe(16);
  });

  test('draws a list in the wide panel with its items wrapping, no text clipped and no sideways scroll', async ({ page }) => {
    await openWorkspace(page);
    await wideButton(page).click();
    await answerWithList(page);
    const list = panel(page).getByRole('list', { name: 'Where it came from' });
    const whole = await list.evaluate((element) => [...element.querySelectorAll('li')].map((item) => item.scrollWidth <= item.clientWidth));
    expect(whole).toEqual([true, true]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test('keeps every time stamp on one line in the wide panel, where the table has room', async ({ page }) => {
    await openWorkspace(page);
    await wideButton(page).click();
    await answerWithStamps(page);
    const oneLine = await panel(page).getByRole('table').evaluate((element) => [...element.querySelectorAll('tbody tr')].map((row) => (row.children[3] as HTMLElement).getBoundingClientRect().height < 32));
    expect(oneLine).toEqual([true, true, true]);
  });

  test('keeps the time stamps on one line at the default width and in the wide panel, and whole and clear of Source at the end of the scroll when it goes back', async ({ page }) => {
    await openWorkspace(page);
    await answerWithStamps(page);
    const table = panel(page).getByRole('table');
    const stamps = () => table.evaluate((element) => {
      const source = element.querySelector('th:last-child') as HTMLElement;
      return [...element.querySelectorAll('tbody tr')].map((row) => {
        const cell = row.children[3] as HTMLElement;
        return { oneLine: cell.getBoundingClientRect().height < 32, clear: cell.getBoundingClientRect().right <= source.getBoundingClientRect().left + 1, inside: cell.getBoundingClientRect().left >= (element.closest('.assistant-table-scroll') as HTMLElement).getBoundingClientRect().left - 1, clipped: cell.scrollWidth > cell.clientWidth };
      });
    });
    const scroller = panel(page).locator('.assistant-table-scroll');
    const toEnd = async () => { await scroller.evaluate((element) => { element.scrollLeft = element.scrollWidth; }); await expect(scroller).not.toHaveClass(/assistant-table-scrolls/); };
    // the title column keeps a readable identifier, so at the default width the table may scroll inside itself: its end is what is measured
    await toEnd();
    for (const stamp of await stamps()) expect(stamp).toMatchObject({ oneLine: true, clear: true, inside: true, clipped: false });
    await wideButton(page).click();
    await expect.poll(async () => (await stamps()).every((stamp) => stamp.oneLine)).toBe(true);
    await wideButton(page).click();
    await toEnd();
    await expect.poll(async () => (await stamps()).every((stamp) => stamp.clear && stamp.inside && !stamp.clipped)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});
