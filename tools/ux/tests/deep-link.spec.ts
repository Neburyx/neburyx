import { expect, test, type Page } from '@playwright/test';
import { canvasOf } from './support/workspace.ts';

test.use({ baseURL: 'http://127.0.0.1:4175' });

const heading = (page: Page) => page.getByRole('heading', { level: 1 });
const sourceLine = (page: Page) => page.locator('section[aria-label="Source"]');
const caseRef = (): string => `REF-DL-${Date.now()}`;

function posts(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/v1/investigations') seen.push(request.postData() ?? '');
  });
  return seen;
}

async function pasteAndOpen(page: Page, text: string): Promise<void> {
  const form = page.getByRole('form', { name: 'Open a link' });
  await form.getByLabel('Link').fill(text);
  await form.getByRole('button', { name: 'Open' }).click();
}

test.describe('following a deep link in a browser', () => {
  test('opens the entity from the address with its case reference, the address becomes the investigation’s, and a reload shows the same', async ({ page }) => {
    const reference = caseRef();
    await page.goto(`/banking-demo/entity/account/AC-1?caseRef=${reference}`);
    await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
    await expect(heading(page)).toHaveText('account AC-1');
    await expect(page.getByText(reference)).toBeVisible();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
    await expect(sourceLine(page)).toContainText('banking-demo');
    const address = page.url();
    await page.reload();
    await expect(page).toHaveURL(address);
    await expect(heading(page)).toHaveText('account AC-1');
  });

  for (const stableId of ['..', '~..', 'AC.1', '1.2.3', 'x..', 'a%2Fb']) {
    test(`serves the page for an address with the ID ${stableId} when it is entered, opens the entity, and the investigation reloads`, async ({ page }) => {
      const response = await page.goto(`/banking-demo/entity/account/${stableId === '..' ? '~..' : stableId}`);
      expect(response?.status()).toBe(200);
      await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
      await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
      await page.reload();
      await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
    });
  }

  test('sends one open, and a reload, Back and Forward send no more, when the link has no case reference', async ({ page }) => {
    const sent = posts(page);
    await page.goto('/dev/open-link');
    await pasteAndOpen(page, '/banking-demo/entity/account/AC-NR-1');
    await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
    await expect(heading(page)).toHaveText('account AC-NR-1');
    expect(sent).toHaveLength(1);
    await page.reload();
    await expect(heading(page)).toHaveText('account AC-NR-1');
    await page.goBack();
    await expect(page).toHaveURL(/\/dev\/open-link$/);
    await page.goForward();
    await expect(heading(page)).toHaveText('account AC-NR-1');
    expect(sent, 'the open of the link is the only one').toHaveLength(1);
  });

  test('switches to the second source from the prompt and brings the first back, as it was, by its case reference', async ({ page }) => {
    const reference = caseRef();
    await page.goto('/dev/open-link');
    await pasteAndOpen(page, `/banking-demo/entity/account/AC-2?caseRef=${reference}`);
    await expect(heading(page)).toHaveText('account AC-2');
    await page.goBack();
    await pasteAndOpen(page, '/claims-demo/entity/account/CL-2');
    await expect(heading(page)).toHaveText('account CL-2');
    await expect(sourceLine(page)).toContainText('claims-demo');
    await page.goBack();
    await pasteAndOpen(page, `/banking-demo/entity/account/AC-2?caseRef=${reference}`);
    await expect(heading(page)).toHaveText('account AC-2');
    await expect(sourceLine(page)).toContainText('banking-demo');
    await expect(page.locator('.status-strip')).toHaveText('An existing investigation for this case reference was opened.');
  });
});

test.describe('a link that cannot be opened', () => {
  async function pageText(page: Page, address: string): Promise<string> {
    await page.goto(address);
    await expect(heading(page)).toBeVisible();
    return (await page.locator('main').innerText()).replaceAll(/\s+/g, ' ');
  }

  test('shows the same page and words for a source that is not configured, a source that is listed but refused and an entity that is missing', async ({ page }) => {
    const texts = [await pageText(page, '/nowhere/entity/account/AC-1'), await pageText(page, '/restricted-demo/entity/account/AC-1'), await pageText(page, '/banking-demo/entity/account/missing')];
    expect(texts[0]).toContain('No entity was found at this link among the sources you can read.');
    expect(new Set(texts.map((text) => text.replace(/\d+ sources? · \d+ connected|●[^|]*?connected/g, ''))).size).toBe(1);
    await expect(page.locator('.page-heading .source-note')).toHaveCount(0);
    await expect(page.getByText('Synthetic data')).toHaveCount(0);
  });

  test('moves focus to the heading of a message page without drawing a ring on it, and a control on the page keeps the ring', async ({ page }) => {
    await page.goto('/nowhere/entity/account/AC-1');
    await expect(heading(page)).toHaveText('Nothing was found at this link');
    await expect(heading(page)).toBeFocused();
    await expect(heading(page)).toHaveCSS('outline-style', 'none');
    await page.keyboard.press('Tab');
    const home = page.getByRole('link', { name: 'Back to Home' });
    await expect(home).toBeFocused();
    await expect(home).not.toHaveCSS('outline-style', 'none');
  });

  test('shows its own pages for a malformed link and for an entity type the source does not name', async ({ page }) => {
    await page.goto('/banking-demo/entity/account/~');
    await expect(heading(page)).toHaveText('This link is not a valid Neburyx link');
    await page.goto('/banking-demo/entity/nothing/AC-1');
    await expect(heading(page)).toHaveText('This source has no such entity type');
    await expect(page.getByText('banking-demo has no entity type of the name this link gives.')).toBeVisible();
  });

  test('never treats /v1/entity/... as a deep link, and serves the page for the nearby first segments', async ({ page }) => {
    const api = await page.request.get('/v1/entity/account/AC-1');
    expect(api.headers()['content-type']).toContain('application/json');
    for (const first of ['v10', 'healthz', 'readyz']) {
      await page.goto(`/${first}/entity/account/AC-1`);
      await expect(heading(page)).toHaveText('Nothing was found at this link');
    }
  });

  test('keeps the investigation that was on screen when a link cannot be opened', async ({ page }) => {
    await page.goto('/dev/open-link');
    await pasteAndOpen(page, `/banking-demo/entity/account/AC-3?caseRef=${caseRef()}`);
    await expect(heading(page)).toHaveText('account AC-3');
    await page.goBack();
    await pasteAndOpen(page, '/claims-demo/entity/account/missing');
    await expect(heading(page)).toHaveText('Nothing was found at this link');
    await expect(sourceLine(page)).toContainText('banking-demo');
  });
});

test.describe('the prompt', () => {
  test('refuses a link of another host, a javascript address and text that is not a link, with the message beside the field and nothing sent', async ({ page }) => {
    const sent = posts(page);
    await page.goto('/dev/open-link');
    for (const text of ['https://evil.example.test/banking-demo/entity/account/AC-1', 'javascript:alert(1)', 'data:text/html,x', '//evil.example.test/banking-demo/entity/account/AC-1', 'hello']) {
      await pasteAndOpen(page, text);
      await expect(page.getByRole('form', { name: 'Open a link' }).getByRole('alert')).toBeVisible();
      await expect(page).toHaveURL(/\/dev\/open-link$/);
    }
    expect(sent).toEqual([]);
  });
});
