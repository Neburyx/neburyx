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

  test('draws the focus ring on the composer box, not tight around the one-line input, without moving anything', async ({ page }) => {
    await routes(page);
    await openPage(page);
    const field = page.getByLabel('Your message');
    await expect(field).toBeVisible();
    const look = () =>
      page.evaluate(() => {
        const compose = getComputedStyle(document.querySelector('.assistant-compose') as Element);
        const input = getComputedStyle(document.querySelector('.assistant-compose textarea') as Element);
        const box = (document.querySelector('.assistant-compose') as Element).getBoundingClientRect();
        const text = (document.querySelector('.assistant-compose textarea') as Element).getBoundingClientRect();
        return { ring: [compose.outlineStyle, compose.outlineWidth, compose.outlineColor], input: [input.outlineStyle === 'none' || input.outlineColor === 'rgba(0, 0, 0, 0)'], box: [box.x, box.y, box.width, box.height], text: [text.x, text.y, text.width, text.height] };
      });
    await field.evaluate((element) => (element as HTMLElement).blur());
    const before = await look();
    expect(before.ring[0]).toBe('none');
    await field.focus();
    const after = await look();
    expect(after.ring).toEqual(['solid', await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--border-width-current').trim() || '2px'), after.ring[2]]);
    expect(after.ring[2]).toBe(await page.evaluate(() => { const probe = document.createElement('i'); probe.style.color = 'var(--color-focus)'; document.body.append(probe); const colour = getComputedStyle(probe).color; probe.remove(); return colour; }));
    expect(after.input).toEqual([true]);
    expect(after.box).toEqual(before.box);
    expect(after.text).toEqual(before.text);
  });

  const storedTurns = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `0192f000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`,
      seq: index + 1,
      at: new Date(Date.UTC(2026, 10, 18, 10, index)).toISOString(),
      route: 'view',
      outcome: 'answered',
      citedElements: 1,
      steps: 0,
      question: `Question number ${index + 1}: who holds the accounts that moved money to the counterparties of this customer last week, and over what period?`,
    }));

  async function openStoredPage(page: Page, count = 16): Promise<void> {
    await page.route((url) => url.pathname === '/v1/ai/status', (route) => route.fulfill({ json: STATUS }));
    await page.route((url) => /^\/v1\/assistant\/investigations\/[^/]+\/thread$/.test(url.pathname), (route) => route.fulfill({ json: { turns: storedTurns(count), earlierTurns: 0, previousThreadClearedAt: null } }));
    await page.route((url) => url.pathname === '/v1/assistant/threads', (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
    await openPage(page);
  }

  const atEnd = async (page: Page): Promise<{ readonly room: number; readonly overflow: boolean; readonly lastBottom: number; readonly formTop: number }> =>
    page.evaluate(() => {
      const body = document.querySelector('.assistant-surface-page .assistant-body') as HTMLElement;
      const form = document.querySelector('.assistant-surface-page .ask-form') as HTMLElement;
      const turns = [...body.querySelectorAll('li, [data-assistant-turn], .assistant-stored-turn')];
      const last = turns.at(-1) ?? body.lastElementChild;
      return { room: body.scrollHeight - body.clientHeight - body.scrollTop, overflow: body.scrollHeight > body.clientHeight + 40, lastBottom: last?.getBoundingClientRect().bottom ?? 0, formTop: form.getBoundingClientRect().top };
    });

  test('opens a stored chat at its latest turn, just above the composer', async ({ page }) => {
    await openStoredPage(page);
    await expect(page.getByText('Question number 16', { exact: false })).toBeVisible();
    const state = await atEnd(page);
    expect(state.overflow).toBe(true);
    expect(state.room).toBeLessThanOrEqual(2);
    expect(state.lastBottom).toBeLessThanOrEqual(state.formTop + 1);
  });

  test('opens the latest turn again for another investigation, and does not move a person who scrolled up when the chat is read again', async ({ page }) => {
    await openStoredPage(page);
    await expect(page.getByText('Question number 16', { exact: false })).toBeVisible();
    const body = page.locator('.assistant-surface-page .assistant-body');
    await body.hover();
    await page.mouse.wheel(0, -4000);
    await expect.poll(async () => (await atEnd(page)).room).toBeGreaterThan(200);
    const before = await body.evaluate((element) => element.scrollTop);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(600);
    expect(Math.abs((await body.evaluate((element) => element.scrollTop)) - before)).toBeLessThanOrEqual(2);
    await openPage(page);
    await expect(page.getByText('Question number 16', { exact: false })).toBeVisible();
    await expect.poll(async () => (await atEnd(page)).room).toBeLessThanOrEqual(2);
  });

  test('draws the stored chat at its end with no animation when the person asks for reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openStoredPage(page);
    await expect(page.getByText('Question number 16', { exact: false })).toBeVisible();
    expect(await page.locator('.assistant-surface-page .assistant-body').evaluate((element) => getComputedStyle(element).scrollBehavior)).toBe('auto');
    expect((await atEnd(page)).room).toBeLessThanOrEqual(2);
  });

  test('does not pull a person back to the end who scrolled up by the scrollbar or a key, when the content grows', async ({ page }) => {
    await openStoredPage(page);
    await expect(page.getByText('Question number 16', { exact: false })).toBeVisible();
    const body = page.locator('.assistant-surface-page .assistant-body');
    // a scrollbar drag sends no wheel, touch or key event: only the scroll itself
    await body.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect.poll(async () => (await atEnd(page)).room).toBeGreaterThan(200);
    await body.evaluate((element) => {
      const spacer = document.createElement('div');
      spacer.style.height = '300px';
      element.firstElementChild?.append(spacer);
    });
    await page.waitForTimeout(400);
    expect((await atEnd(page)).room).toBeGreaterThan(200);
  });

  test('reads a turn that is sent in a stored chat from its top, and does not pull it to the end', async ({ page }) => {
    const tall: AssistantTurnAnswer = { ...TABLE, blocks: [0, 1, 2].flatMap((copy) => TABLE.blocks.map((block) => (block.kind === 'table' ? { ...block, table: { ...block.table, title: copy === 0 ? block.table.title : `${block.table.title} (${copy + 1})` } } : block))) } as AssistantTurnAnswer;
    await openStoredPage(page);
    await page.route((url) => url.pathname === '/v1/assistant/turns', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({ json: tall });
    });
    await expect(page.getByText('Question number 16', { exact: false })).toBeVisible();
    await page.getByLabel('Your message').fill('show them as a table');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-assistant-turn]').first()).toBeVisible();
    await page.waitForTimeout(600);
    const place = await page.evaluate(() => {
      const body = document.querySelector('.assistant-surface-page .assistant-body') as HTMLElement;
      const turn = document.querySelector('[data-assistant-turn]') as HTMLElement | null;
      return { turnTop: turn?.getBoundingClientRect().top ?? -1, bodyTop: body.getBoundingClientRect().top, bodyBottom: body.getBoundingClientRect().bottom, room: body.scrollHeight - body.clientHeight - body.scrollTop };
    });
    expect(place.turnTop).toBeGreaterThanOrEqual(place.bodyTop - 2);
    expect(place.turnTop).toBeLessThan(place.bodyBottom);
    expect(place.room).toBeGreaterThan(50);
  });

  test('centres the empty thread in the free area, as frame 5b-2 draws it: the mark 194.5 px under the header at 900 px, the same room above and below', async ({ page }) => {
    await routes(page);
    await openPage(page);
    await expect(page.locator('.assistant-empty')).toBeVisible();
    const found = await page.evaluate(() => {
      const body = (document.querySelector('.assistant-surface-page .assistant-body') as HTMLElement).getBoundingClientRect();
      const mark = (document.querySelector('.assistant-empty .assistant-empty-icon') as HTMLElement).getBoundingClientRect();
      const line = (document.querySelector('.assistant-empty .assistant-empty-line') as HTMLElement).getBoundingClientRect();
      const title = (document.querySelector('.assistant-empty h2') as HTMLElement).getBoundingClientRect();
      const text = (document.querySelector('.assistant-empty > p') as HTMLElement).getBoundingClientRect();
      const first = (document.querySelector('.assistant-empty-suggestions button') as HTMLElement).getBoundingClientRect();
      const last = [...document.querySelectorAll('.assistant-empty-suggestions button')].at(-1)?.getBoundingClientRect() as DOMRect;
      return { bodyTop: body.top, bodyBottom: body.bottom, markTop: mark.top, titleTop: title.top, titleHeight: title.height, textTop: text.top, textHeight: text.height, firstTop: first.top, firstHeight: first.height, lastBottom: last.bottom, lineTop: line.top, lineHeight: line.height, lineBottom: line.bottom };
    });
    expect(found.markTop - found.bodyTop).toBeCloseTo(found.bodyBottom - found.lineBottom, 0);
    if ((page.viewportSize()?.height ?? 0) === 900) {
      expect(found.markTop).toBeCloseTo(64 + 194.5, 0);
      expect(found.titleTop).toBeCloseTo(64 + 256.5, 0);
      expect(found.titleHeight).toBeCloseTo(24, 0);
      expect(found.textTop).toBeCloseTo(64 + 294.5, 0);
      expect(found.textHeight).toBeCloseTo(44, 0);
      expect(found.firstTop).toBeCloseTo(64 + 352.5, 0);
      expect(found.firstHeight).toBeCloseTo(36, 0);
      expect(found.lastBottom - found.firstTop).toBeCloseTo(124, 0);
      expect(found.lineTop).toBeCloseTo(64 + 490.5, 0);
      expect(found.lineHeight).toBeCloseTo(15, 0);
    }
  });

  test('draws the investigation shown as the current row of the list while it has no chat, and the real row replaces it after the first question', async ({ page }) => {
    let chats: unknown[] = [];
    await page.route((url) => url.pathname === '/v1/ai/status', (route) => route.fulfill({ json: STATUS }));
    await page.route((url) => /^\/v1\/assistant\/investigations\/[^/]+\/thread$/.test(url.pathname), (route) => route.fulfill({ json: EMPTY }));
    await page.route((url) => url.pathname === '/v1/assistant/threads', (route) => route.fulfill({ json: { items: chats, nextCursor: null } }));
    await page.route((url) => url.pathname === '/v1/assistant/turns', (route) => {
      const id = new URL(page.url()).pathname.split('/').pop() ?? '';
      chats = [{ investigationId: id, title: 'Account AC-1', caseRef: null, sourceId: 'banking-demo', sourceAlias: 'banking-demo', sourceState: 'available', lastQuestionAt: new Date().toISOString(), turns: 1, lastQuestion: 'show them as a table', lastQuestionCut: false }];
      return route.fulfill({ json: TABLE });
    });
    await openPage(page);
    const today = page.getByRole('list', { name: 'Today' });
    await expect(today.getByRole('listitem')).toHaveCount(1);
    await expect(today.getByRole('listitem')).toContainText('No questions yet');
    await expect(today.getByRole('link')).toHaveCount(0);
    await expect(today.locator('[aria-current="true"]')).toHaveCount(1);
    await page.getByRole('searchbox', { name: 'Search chats' }).fill('zzqx');
    await expect(page.getByText('No chats match your search.')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Today' })).toHaveCount(0);
    await page.getByRole('searchbox', { name: 'Search chats' }).fill('');
    await expect(today.getByRole('listitem')).toHaveCount(1);
    await page.getByLabel('Your message').fill('show them as a table');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('table', { name: 'Accounts · 6 rows' })).toBeVisible();
    await expect(today.getByRole('listitem')).toHaveCount(1);
    await expect(today.getByRole('link')).toHaveCount(1);
    await expect(today.getByRole('listitem')).toContainText('show them as a table');
  });
});
