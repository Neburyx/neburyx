import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ASSISTANT_REFUSAL_SENTENCES } from '@neburyx/contracts';
import { canvasOf } from './support/workspace.ts';

const STATUS = { ask: { available: true }, summary: { available: true }, assistant: { available: true, messageWords: 1000, model: 'claude-sonnet-5-5' } };
const EMPTY = { turns: [], earlierTurns: 0, previousThreadClearedAt: null };
const panel = (page: Page) => page.locator('.assistant-panel');
const popOutButton = (page: Page) => panel(page).getByRole('button', { name: 'Pop out' });
const NOTE = 'The chat is open in another window';
const STORE_LAG_MS = 900;

/** The stored thread of the stub server: a turn answered through POST turns is in what the thread read returns, as on the real server. */
async function stubs(context: BrowserContext): Promise<{ readonly turns: object[]; clear(): void }> {
  const stored: object[] = [];
  await context.route((url) => url.pathname === '/v1/ai/status', (route) => route.fulfill({ json: STATUS }));
  await context.route((url) => /^\/v1\/assistant\/investigations\/[^/]+\/thread$/.test(url.pathname), (route) => route.fulfill({ json: { ...EMPTY, turns: [...stored] } }));
  await context.route((url) => url.pathname === '/v1/assistant/turns', (route) => {
    const seq = stored.length + 1;
    const sent = route.request().postDataJSON() as { turnId?: string };
    // the server stores the turn a moment after it has answered, as the real one does
    setTimeout(() => stored.push({ id: sent.turnId ?? `0192f000-0000-7000-8000-0000000000${String(seq).padStart(2, '0')}`, seq, at: '2026-11-25T10:00:00.000Z', route: 'refuse', outcome: 'refused', cause: 'verdict', citedElements: 0, steps: 0 }), STORE_LAG_MS);
    return route.fulfill({ json: { status: 'answered', route: 'refuse', cause: 'verdict', sentence: ASSISTANT_REFUSAL_SENTENCES.verdict } });
  });
  return { turns: stored, clear: () => void (stored.length = 0) };
}

const storedRows = (page: Page) => page.locator('.assistant-stored-list > li');
const ask = async (page: Page, text: string): Promise<void> => {
  await page.getByLabel('Your message').fill(text);
  await page.keyboard.press('Enter');
};

async function openInvestigation(page: Page): Promise<string> {
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
  const id = /\/explore\/([0-9a-f-]{36})/.exec(page.url())?.[1];
  if (id === undefined) throw new Error('the investigation is not in the address');
  return id;
}

async function openPanel(page: Page): Promise<void> {
  await page.getByRole('banner', { name: 'Investigation' }).getByRole('button', { name: 'Assistant' }).click();
  await expect(panel(page)).toBeVisible();
}

async function popOut(page: Page): Promise<Page> {
  const [popup] = await Promise.all([page.waitForEvent('popup'), popOutButton(page).click()]);
  await popup.waitForLoadState();
  return popup;
}

test.describe('Pop out of the Assistant panel', () => {
  test('opens the page of the chat in a window of its own with the app header and sidebar, collapses the panel to its note, and restores it when the window closes', async ({ page, context }) => {
    await stubs(context);
    const id = await openInvestigation(page);
    await openPanel(page);
    const popup = await popOut(page);
    await expect(popup).toHaveURL(new RegExp(`/assistant/${id}$`));
    await expect(popup.locator('.sidebar')).toBeVisible();
    await expect(popup.locator('.assistant-page-head')).toBeVisible();
    await expect(panel(page).getByText(NOTE)).toBeVisible();
    await expect(panel(page).getByLabel('Your message')).toBeHidden();
    await expect(popOutButton(page)).toHaveAttribute('aria-pressed', 'true');
    await popup.close();
    await expect(panel(page).getByText(NOTE)).toBeHidden({ timeout: 10_000 });
    await expect(panel(page).getByLabel('Your message')).toBeVisible();
  });

  test('focuses the window on a second press and neither opens another nor reloads it, also after the panel has been reloaded', async ({ page, context }) => {
    await stubs(context);
    await openInvestigation(page);
    await openPanel(page);
    const popup = await popOut(page);
    await popup.evaluate(() => {
      (window as unknown as { marker: string }).marker = 'still here';
    });
    const extra = page.waitForEvent('popup', { timeout: 1500 }).then(() => true, () => false);
    await popOutButton(page).click();
    expect(await extra).toBe(false);
    expect(context.pages()).toHaveLength(2);
    expect(await popup.evaluate(() => (window as unknown as { marker: string }).marker)).toBe('still here');
    await page.reload();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
    await openPanel(page);
    await expect(panel(page).getByText(NOTE)).toBeVisible();
    const again = page.waitForEvent('popup', { timeout: 1500 }).then(() => true, () => false);
    await popOutButton(page).click();
    expect(await again).toBe(false);
    expect(context.pages()).toHaveLength(2);
    expect(await popup.evaluate(() => (window as unknown as { marker: string }).marker)).toBe('still here');
  });

  test('uses the window it opened for the page again when the person has left the page in it', async ({ page, context }) => {
    await stubs(context);
    const id = await openInvestigation(page);
    await openPanel(page);
    const popup = await popOut(page);
    await popup.getByRole('navigation').getByRole('link', { name: 'Home' }).click();
    await expect(popup).not.toHaveURL(/\/assistant\//);
    await expect(panel(page).getByText(NOTE)).toBeHidden({ timeout: 10_000 });
    const extra = page.waitForEvent('popup', { timeout: 1500 }).then(() => true, () => false);
    await popOutButton(page).click();
    expect(await extra).toBe(false);
    await expect(popup).toHaveURL(new RegExp(`/assistant/${id}$`));
    expect(context.pages()).toHaveLength(2);
  });

  test('shows a turn made in either window in the other without a reload, while both show the chat', async ({ page, context }) => {
    await stubs(context);
    const id = await openInvestigation(page);
    await openPanel(page);
    const popup = await popOut(page);
    await panel(page).getByRole('button', { name: 'Show the chat here' }).click();
    await ask(popup, 'what is here?');
    await expect(popup.getByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeVisible();
    await expect(storedRows(page)).toHaveCount(1, { timeout: 8000 });
    await ask(page, 'and this?');
    await expect(panel(page).getByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeVisible();
    await expect(storedRows(popup)).toHaveCount(1, { timeout: 8000 });
    await expect(popup).toHaveURL(new RegExp(`/assistant/${id}$`));
  });

  test('brings the panel back at once when the window closes, as a window that is closing says so', async ({ page, context }) => {
    await stubs(context);
    await openInvestigation(page);
    await openPanel(page);
    const popup = await popOut(page);
    await expect(panel(page).getByText(NOTE)).toBeVisible();
    const started = Date.now();
    await popup.evaluate(() => window.close());
    await expect(panel(page).getByText(NOTE)).toBeHidden({ timeout: 4000 });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test('leaves the page where it is when the browser blocks the window, says so, and gives a link that opens the chat here', async ({ page, context }) => {
    await stubs(context);
    await page.addInitScript(() => {
      window.open = () => null;
    });
    const id = await openInvestigation(page);
    await openPanel(page);
    await popOutButton(page).click();
    await expect(page).toHaveURL(new RegExp(`/explore/${id}$`));
    const line = panel(page).getByRole('status').filter({ hasText: 'could not be opened' });
    await expect(line).toBeVisible();
    await line.getByRole('link', { name: 'Open the chat in this window' }).click();
    await expect(page).toHaveURL(new RegExp(`/assistant/${id}$`));
  });

  test('keeps the panel as it was for a page of another investigation', async ({ page, context }) => {
    await stubs(context);
    await openInvestigation(page);
    await openPanel(page);
    const other = await context.newPage();
    await openInvestigation(other);
    await other.getByRole('navigation').getByRole('link', { name: 'Home' }).click();
    await other.getByRole('link', { name: 'Assistant' }).click();
    await expect(other).toHaveURL(/\/assistant\/[0-9a-f-]{36}$/);
    await other.waitForTimeout(500);
    await expect(panel(page).getByText(NOTE)).toBeHidden();
    await expect(panel(page).getByLabel('Your message')).toBeVisible();
  });

  test('tells why nothing was switched to when the page is open in a window it cannot reach, without moving the header or clipping the text, at the opening width and wide', async ({ page, context }) => {
    await stubs(context);
    const id = await openInvestigation(page);
    await openPanel(page);
    const other = await context.newPage();
    await other.goto(`/assistant/${id}`);
    await expect(panel(page).getByText(NOTE)).toBeVisible({ timeout: 10_000 });
    const head = panel(page).locator('.ask-head');
    const before = await head.boundingBox();
    const lookup = page.waitForEvent('popup', { timeout: 3000 }).catch(() => null);
    await popOutButton(page).click();
    const line = panel(page).getByRole('status').filter({ hasText: 'cannot switch to' });
    await expect(line).toBeVisible();
    const emptied = await lookup;
    if (emptied !== null && !emptied.isClosed()) await emptied.waitForEvent('close', { timeout: 5000 });
    expect(context.pages().filter((entry) => !entry.isClosed())).toHaveLength(2);
    const measure = async () => {
      const after = await head.boundingBox();
      expect(after?.y).toBe(before?.y);
      expect(after?.height).toBe(before?.height);
      const box = await line.boundingBox();
      const frame = await panel(page).boundingBox();
      expect(box && frame ? box.x >= frame.x && box.x + box.width <= frame.x + frame.width : false).toBe(true);
      expect(await line.evaluate((element) => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)).toBe(true);
      await expect(panel(page).getByText(NOTE)).toBeVisible();
    };
    await measure();
    await panel(page).getByRole('button', { name: 'Wide' }).click();
    await expect(line).toBeVisible();
    await measure();
    await other.close();
    await expect(line).toBeHidden({ timeout: 10_000 });
  });

  test('is reached from the keyboard, and shows its tooltip and the note as the frames draw them', async ({ page, context }, info) => {
    await stubs(context);
    await openInvestigation(page);
    await openPanel(page);
    await popOutButton(page).focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(popOutButton(page)).toBeFocused();
    const tip = page.getByRole('tooltip');
    await expect(tip).toContainText('Open this chat as a full page in a new window');
    const drawn = await tip.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const lines = [...element.children].map((child) => getComputedStyle(child));
      return { width: box.width, height: box.height, background: getComputedStyle(element).backgroundColor, first: [lines[0]?.fontWeight, lines[0]?.color], second: [lines[1]?.fontWeight, lines[1]?.color] };
    });
    expect(Math.round(drawn.height)).toBe(44);
    expect(drawn.width).toBeGreaterThan(270);
    expect(drawn.width).toBeLessThan(285);
    expect(drawn.background).toBe('rgb(37, 41, 50)');
    expect(drawn.first).toEqual(['500', 'rgb(255, 255, 255)']);
    expect(drawn.second).toEqual(['400', 'rgb(223, 227, 238)']);
    const button = await popOutButton(page).evaluate((element) => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height, background: getComputedStyle(element).backgroundColor }));
    expect(button).toEqual({ width: 21, height: 21, background: 'rgb(234, 237, 247)' });
    const shots = process.env['NBX_UX_SHOTS'];
    if (shots !== undefined) await page.screenshot({ path: `${shots}/pop-out-tooltip-${info.project.name}.png` });
    await page.keyboard.press('Enter');
    const popup = await page.waitForEvent('popup');
    await expect(panel(page).getByText(NOTE)).toBeVisible();
    const collapsed = await panel(page).evaluate((element) => {
      const icon = element.querySelector('.assistant-popped-icon')?.getBoundingClientRect();
      const wide = element.querySelector('.assistant-wide[aria-label="Wide"]');
      const subtitle = element.querySelector('.ask-head-text p');
      return { icon: [icon?.width, icon?.height], iconColor: getComputedStyle(element.querySelector('.assistant-popped-icon') as Element).color, subtitle: subtitle === null ? '' : getComputedStyle(subtitle).color, wideTip: wide === null ? '' : getComputedStyle(wide, '::after').content };
    });
    expect(collapsed.icon.map((value) => Math.round((value ?? 0) * 10) / 10)).toEqual([10.4, 10.4]);
    expect(collapsed.iconColor).toBe('rgb(82, 100, 167)');
    expect(collapsed.subtitle).toBe('rgb(100, 109, 128)');
    expect(collapsed.wideTip).toBe('none');
    await popOutButton(page).blur();
    const box = await page.locator('.floating-panel', { has: panel(page) }).boundingBox();
    expect(box?.width).toBe(380);
    expect(Math.round(box?.height ?? 0)).toBe(189);
    if (shots !== undefined) await page.screenshot({ path: `${shots}/pop-out-collapsed-${info.project.name}.png` });
    await popup.close();
  });
});
