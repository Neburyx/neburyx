import { expect, test, type Page } from '@playwright/test';
import type { AssistantTurnAnswer } from '@neburyx/contracts';

const STATUS = { ask: { available: true }, summary: { available: true }, assistant: { available: true, messageWords: 1000, model: 'claude-sonnet-5-5' } };
const EMPTY = { turns: [], earlierTurns: 0, previousThreadClearedAt: null };

async function routes(page: Page, answer?: AssistantTurnAnswer): Promise<void> {
  await page.route((url) => url.pathname === '/v1/ai/status', (route) => route.fulfill({ json: STATUS }));
  await page.route((url) => /^\/v1\/assistant\/investigations\/[^/]+\/thread$/.test(url.pathname), (route) => route.fulfill({ json: EMPTY }));
  if (answer !== undefined) await page.route((url) => url.pathname === '/v1/assistant/turns', (route) => route.fulfill({ json: answer }));
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

const TABLE: AssistantTurnAnswer = {
  status: 'answered',
  route: 'view',
  blocks: [{ kind: 'table', table: { title: 'Accounts · 6 rows', columns: ['Element', 'A rather long column label to widen it', 'Another long column label'], rows: Array.from({ length: 6 }, (_, index) => ({ cells: [`row-${index + 1}`, `a long cell text for row ${index + 1} of the table`, 'value'], cites: ['n1'] })), note: 'Each row selects its elements on the graph.' } }],
  citations: [{ key: 'n1', kind: 'entity', ref: { sourceId: 'banking-demo', entityType: 'account', stableId: 'AC-1' } }],
  coverage: { retrieval: '1 shown · 0 not yet retrieved (exact)', summary: '6 accounts in view shown · exact' },
  model: 'claude-sonnet-5-5',
  calls: 2,
};

test.describe('The Assistant page', () => {
  test('fits its header, thread column and composer, with nothing overlapping or wider than the area', async ({ page }) => {
    await routes(page, TABLE);
    await openPage(page);
    const area = await page.locator('.assistant-page-thread').boundingBox();
    const head = await page.locator('.assistant-page-head').boundingBox();
    expect(head?.height).toBe(64);
    expect((await page.locator('.sidebar').boundingBox())?.width).toBe(208);
    await expect(page.getByRole('link', { name: 'Open graph' })).toBeVisible();
    await page.getByLabel('Your message').fill('show them as a table');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('table', { name: 'Accounts · 6 rows' })).toBeVisible();
    const table = await page.getByRole('table', { name: 'Accounts · 6 rows' }).boundingBox();
    expect(table && area ? table.width <= Math.min(720, area.width) + 1 : false).toBe(true);
    const form = await page.locator('.assistant-compose').boundingBox();
    const body = await page.locator('.assistant-surface-page .assistant-body').boundingBox();
    expect(form && body ? form.y >= body.y + body.height - 1 : false).toBe(true);
    const input = await page.getByLabel('Your message').boundingBox();
    const column = await page.locator('.assistant-thread').boundingBox();
    expect(input && area ? input.width <= 720 + 1 : false).toBe(true);
    expect(column && area ? Math.abs(column.x + column.width / 2 - (area.x + area.width / 2)) <= 2 && column.width <= 720 + 1 : false).toBe(true);
    expect(head && form ? head.y + head.height <= form.y : false).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('draws the table as the frame does: cells on one line sized to their content, the light header fill of the frame, rows of about 33 px, Copy table as a link, the arrow to the source only on row hover', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await routes(page, TABLE);
    await openPage(page);
    await page.getByLabel('Your message').fill('show them as a table');
    await page.keyboard.press('Enter');
    const table = page.getByRole('table', { name: 'Accounts · 6 rows' });
    await expect(table).toBeVisible();
    const measured = await table.evaluate((element) => {
      const rows = [...element.querySelectorAll('tbody tr')] as HTMLElement[];
      const head = element.querySelector('thead th') as HTMLElement;
      const cells = [...element.querySelectorAll('tbody td')] as HTMLElement[];
      const copy = element.closest('.assistant-table-block')?.querySelector('.assistant-table-copy') as HTMLElement;
      return {
        rowHeights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
        headFill: getComputedStyle(element.querySelector('thead') as HTMLElement).backgroundColor,
        oneLine: cells.every((cell) => cell.getBoundingClientRect().height < 40),
        copyBorder: getComputedStyle(copy).borderTopWidth,
        copyIcon: copy.querySelector('.icon') === null,
      };
    });
    for (const height of measured.rowHeights) expect(height).toBeGreaterThanOrEqual(30);
    for (const height of measured.rowHeights) expect(height).toBeLessThanOrEqual(36);
    expect(measured.headFill).toBe('rgb(247, 248, 250)');
    expect(measured.oneLine).toBe(true);
    expect(measured.copyBorder).toBe('0px');
    expect(measured.copyIcon).toBe(true);
    const arrow = table.locator('tbody tr').first().getByRole('button', { name: /^Show source/ });
    const layout = () => table.evaluate((element) => [...element.querySelectorAll('tbody tr')].map((row) => [...row.children].map((cell) => Math.round(cell.getBoundingClientRect().width)).join(',')).join(';'));
    const before = await layout();
    await expect(arrow).toHaveCSS('opacity', '0');
    await table.locator('tbody tr').first().hover();
    await expect(arrow).toHaveCSS('opacity', '1');
    expect(await layout()).toBe(before);
  });

  test('reaches Open graph, the thread controls and the composer by keyboard in reading order, and Enter in the composer sends', async ({ page }) => {
    await routes(page, TABLE);
    await openPage(page);
    await page.getByLabel('Your message').fill('first');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('table', { name: 'Accounts · 6 rows' })).toBeVisible();
    const seen: string[] = [];
    await page.getByRole('link', { name: 'Assistant' }).focus();
    for (let presses = 0; presses < 40 && !seen.includes('composer'); presses += 1) {
      await page.keyboard.press('Tab');
      seen.push(await page.evaluate(() => (document.activeElement?.id === 'assistant-message' ? 'composer' : (document.activeElement?.textContent ?? '').trim().slice(0, 20))));
    }
    expect(seen.indexOf('Open graph')).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf('Clear chat')).toBeGreaterThan(seen.indexOf('Open graph'));
    expect(seen.indexOf('composer')).toBeGreaterThan(seen.indexOf('Clear chat'));
  });

  test('shows the empty thread with its suggestions and the model line, and a suggestion sends its text', async ({ page }) => {
    await routes(page, TABLE);
    await openPage(page);
    await expect(page.getByRole('button', { name: 'Summarize what is on screen' })).toBeVisible();
    await expect(page.getByText(/Model: claude-sonnet-5-5/)).toBeVisible();
    const sent = page.waitForRequest((request) => request.url().endsWith('/v1/assistant/turns'));
    await page.getByRole('button', { name: 'Summarize what is on screen' }).click();
    expect((await sent).postDataJSON()).toMatchObject({ message: 'Summarize what is on screen' });
  });

  test('shows the not-available message and no usable composer when the Assistant is unavailable, reachable by keyboard', async ({ page }) => {
    await routes(page);
    await page.route((url) => url.pathname === '/v1/ai/status', (route) => route.fulfill({ json: { ask: { available: false }, summary: { available: false }, assistant: { available: false } } }));
    await openPage(page);
    await expect(page.getByText('Not available', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Your message')).toBeDisabled();
    await page.getByRole('link', { name: 'Assistant' }).focus();
    await expect(page.getByRole('link', { name: 'Assistant' })).toBeFocused();
  });

  test('shows in the panel of Explore the question sent on the page', async ({ page }) => {
    await routes(page, TABLE);
    await openPage(page);
    await page.getByLabel('Your message').fill('asked on the page');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('table', { name: 'Accounts · 6 rows' })).toBeVisible();
    await page.getByRole('link', { name: 'Open graph' }).click();
    await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
    await page.getByRole('banner', { name: 'Investigation' }).getByRole('button', { name: 'Assistant' }).click();
    await expect(page.locator('.assistant-panel').getByText('asked on the page')).toBeVisible();
  });

  test('says an investigation must be opened first when none is held', async ({ page }) => {
    await routes(page);
    await page.goto('/assistant');
    await expect(page.getByRole('heading', { name: 'Open an investigation first' })).toBeVisible();
    await expect(page.getByLabel('Your message')).toHaveCount(0);
  });

  test('draws the composer where frames 5a, 5a-ii and 5b-2 draw it: a box of 85 px, the note 8 px under it, 20 px above the window bottom, with the thread filling the rest', async ({ page }) => {
    await routes(page, TABLE);
    await openPage(page);
    const height = page.viewportSize()?.height ?? 0;
    const box = async (selector: string) => {
      const found = await page.locator(selector).first().boundingBox();
      if (found === null) throw new Error(`${selector} is not drawn`);
      return found;
    };
    const check = async (): Promise<void> => {
      const area = await box('.assistant-page-thread');
      const form = await box('.assistant-surface-page .ask-form');
      const compose = await box('.assistant-compose');
      const note = await box('.assistant-page-note');
      const input = await box('.assistant-compose textarea');
      const send = await box('.assistant-compose .ask-send');
      const body = await box('.assistant-surface-page .assistant-body');
      expect(area.y + area.height).toBe(height);
      expect(form.y).toBeCloseTo(height - 136, 0);
      expect(compose.height).toBeCloseTo(85, 0);
      expect(compose.y).toBeCloseTo(height - 128, 0);
      expect(compose.width).toBe(720);
      expect(compose.x - area.x).toBeCloseTo((area.width - 720) / 2, 0);
      expect(input.height).toBeCloseTo(17, 0);
      expect(send.height).toBeCloseTo(34, 0);
      expect(note.y - (compose.y + compose.height)).toBeCloseTo(8, 0);
      expect(note.height).toBeCloseTo(15, 0);
      expect(height - (note.y + note.height)).toBeCloseTo(20, 0);
      expect(body.y + body.height).toBeLessThanOrEqual(form.y + 0.5);
    };
    await check();
    const look = await page.evaluate(() => {
      const style = (selector: string) => getComputedStyle(document.querySelector(selector) as Element);
      return {
        border: style('.assistant-compose').borderTopColor,
        input: style('.assistant-compose textarea').fontSize,
        counter: style('.assistant-compose .ask-counter').color,
        note: style('.assistant-page-note').color,
        send: [style('.assistant-compose .ask-send').backgroundColor, style('.assistant-compose .ask-send').borderTopColor, style('.assistant-compose .ask-send').color],
      };
    });
    expect(look).toEqual({ border: 'rgb(202, 208, 218)', input: '14px', counter: 'rgb(100, 109, 128)', note: 'rgb(100, 109, 128)', send: ['rgb(247, 248, 250)', 'rgb(227, 230, 236)', 'rgb(100, 109, 128)'] });
    await page.getByLabel('Your message').fill('show them as a table');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('table', { name: 'Accounts · 6 rows' })).toBeVisible();
    await check();
  });

  test('keeps the composer where the frame puts it when the message grows, when Send is enabled, and while a turn runs with Cancel', async ({ page }) => {
    await routes(page);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route((url) => url.pathname === '/v1/assistant/turns', async (route) => {
      await held;
      await route.fulfill({ json: TABLE });
    });
    await openPage(page);
    const height = page.viewportSize()?.height ?? 0;
    const box = async (selector: string) => {
      const found = await page.locator(selector).first().boundingBox();
      if (found === null) throw new Error(`${selector} is not drawn`);
      return found;
    };
    const field = page.getByLabel('Your message');
    await field.fill(Array.from({ length: 9 }, (_, line) => `line ${line + 1} of a long message`).join('\n'));
    const grown = await box('.assistant-compose');
    const input = await box('.assistant-compose textarea');
    const note = await box('.assistant-page-note');
    const form = await box('.assistant-surface-page .ask-form');
    const body = await box('.assistant-surface-page .assistant-body');
    expect(input.height).toBeLessThanOrEqual(120.5);
    expect(grown.height).toBeGreaterThan(85);
    expect(note.y - (grown.y + grown.height)).toBeCloseTo(8, 0);
    expect(height - (note.y + note.height)).toBeCloseTo(20, 0);
    expect(body.y + body.height).toBeLessThanOrEqual(form.y + 0.5);
    const send = page.locator('.assistant-compose .ask-send');
    expect((await box('.assistant-compose .ask-send')).height).toBeCloseTo(34, 0);
    expect(await send.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(82, 100, 167)');
    await field.fill('show them as a table');
    await page.keyboard.press('Enter');
    const cancel = page.getByRole('button', { name: 'Cancel' });
    await expect(cancel).toBeVisible();
    expect((await box('.assistant-compose .ask-send')).height).toBeCloseTo(34, 0);
    expect((await box('.assistant-compose')).height).toBeCloseTo(85, 0);
    release();
    await expect(page.getByRole('table', { name: 'Accounts · 6 rows' })).toBeVisible();
  });
});
