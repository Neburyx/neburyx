import { expect, test, type Page } from '@playwright/test';
import { summaryResponseSchema, type SummaryResponse } from '@neburyx/contracts';
import { canvasOf } from './support/workspace.ts';

const SENT = 'n1 account AC-1\n  as shown';

const draftFor = (sourceId: string, over: Record<string, unknown> = {}): SummaryResponse =>
  summaryResponseSchema.parse({
    status: 'ok',
    sentences: [{ text: 'AC-1 is an account.', cites: ['n1'], storable: true }],
    citations: [{ key: 'n1', kind: 'entity', ref: { sourceId, entityType: 'account', stableId: 'AC-1' } }],
    coverage: { retrieval: '1 shown · ~38 not yet retrieved (estimated)', summary: 'The draft cites 1 of the 1 shown elements' },
    removedCount: 0,
    sent: SENT,
    model: 'stub-model',
    calls: 1,
    summaryToken: 'tok',
    ...over,
  });

const header = (page: Page) => page.getByRole('banner', { name: 'Investigation' });
const panel = (page: Page) => page.locator('.summary-panel');

async function openWorkspace(page: Page): Promise<void> {
  await page.route((url) => url.pathname === '/v1/ai/status', (route) => route.fulfill({ json: { ask: { available: true }, summary: { available: true }, assistant: { available: false } } }));
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
}

async function answerWith(page: Page, answer: (sourceId: string) => SummaryResponse | Promise<SummaryResponse>, hold?: Promise<void>): Promise<string[]> {
  const bodies: string[] = [];
  await page.route((url) => url.pathname === '/v1/summary', async (route) => {
    const body = route.request().postDataJSON() as { sourceId: string };
    bodies.push(JSON.stringify(body));
    if (hold !== undefined) await hold;
    await route.fulfill({ json: await answer(body.sourceId) });
  });
  return bodies;
}

const summarize = (page: Page) => header(page).getByRole('button', { name: /^Summarize/ });

test.describe('the AI case summary panel', () => {
  test('one click shows the cited draft with its coverage line, and the page never scrolls sideways', async ({ page }) => {
    await openWorkspace(page);
    const bodies = await answerWith(page, (sourceId) => draftFor(sourceId));
    await summarize(page).click();
    await expect(page.getByRole('heading', { name: 'Draft' })).toBeFocused();
    await expect(panel(page).getByLabel('Sentence 1')).toHaveValue('AC-1 is an account.');
    await expect(panel(page).getByText('1 shown · ~38 not yet retrieved (estimated) · The draft cites 1 of the 1 shown elements')).toBeVisible();
    await expect(panel(page).getByText('This is not a finding.')).toBeVisible();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain('Account AC-1');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test('a press on a citation selects the element, and the Inspector sits beside the panel without touching it', async ({ page }) => {
    await openWorkspace(page);
    await answerWith(page, (sourceId) => draftFor(sourceId));
    await summarize(page).click();
    await panel(page).getByRole('button', { name: /^Citation 1/ }).click();
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await expect(inspector).toBeVisible();
    const [left, right] = await Promise.all([inspector.boundingBox(), page.getByRole('complementary', { name: 'AI case summary' }).boundingBox()]);
    expect(left && right && left.x + left.width <= right.x).toBe(true);
  });

  test('the disclosure shows the text sent, exactly', async ({ page }) => {
    await openWorkspace(page);
    await answerWith(page, (sourceId) => draftFor(sourceId));
    await summarize(page).click();
    await panel(page).getByText('What the model sees').click();
    expect(await panel(page).locator('.summary-sent').evaluate((element) => element.textContent)).toBe(SENT);
  });

  test('Cancel ends the wait on the client and leaves the view as it was', async ({ page }) => {
    await openWorkspace(page);
    await answerWith(page, (sourceId) => draftFor(sourceId), new Promise(() => undefined));
    await summarize(page).click();
    await expect(panel(page).locator('.summary-generating-title')).toBeVisible();
    await panel(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(panel(page).getByRole('heading', { name: 'Cancelled' })).toBeFocused();
    await expect(panel(page).getByText('No draft is shown.')).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
  });

  test('Escape cancels first and closes next, and the focus returns to the header control', async ({ page }) => {
    await openWorkspace(page);
    await answerWith(page, (sourceId) => draftFor(sourceId), new Promise(() => undefined));
    await summarize(page).click();
    await expect(panel(page).getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel(page).getByRole('heading', { name: 'Cancelled' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(summarize(page)).toBeFocused();
  });

  test('Regenerate asks again and Discard removes the draft', async ({ page }) => {
    await openWorkspace(page);
    const bodies = await answerWith(page, (sourceId) => draftFor(sourceId));
    await summarize(page).click();
    await panel(page).getByRole('button', { name: 'Regenerate' }).click();
    await expect.poll(() => bodies.length).toBe(2);
    await panel(page).getByRole('button', { name: 'Discard' }).click();
    await expect(panel(page).getByLabel('Sentence 1')).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: 'Summarize' })).toBeFocused();
  });

  test('the Export dialog offers Include AI case summary while there is a draft, and sends its token when it is ticked', async ({ page }) => {
    await openWorkspace(page);
    await answerWith(page, (sourceId) => draftFor(sourceId));
    const exported: string[] = [];
    await page.route((url) => /\/exports$/.test(url.pathname), async (route) => {
      exported.push(route.request().postData() ?? '');
      await route.continue();
    });
    await header(page).getByRole('button', { name: 'Export' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export current view' });
    await expect(dialog.getByRole('checkbox', { name: 'Include AI case summary' })).toBeDisabled();
    await expect(dialog.getByText('Draft a summary first')).toBeVisible();
    await page.keyboard.press('Escape');
    await summarize(page).click();
    await expect(panel(page).getByRole('button', { name: 'Copy to notes' })).toBeVisible();
    await header(page).getByRole('button', { name: 'Export' }).click();
    const option = dialog.getByRole('checkbox', { name: 'Include AI case summary' });
    await expect(option).toBeEnabled();
    await option.check();
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Download JSON' }).click();
    await download;
    expect(JSON.parse(exported[0] ?? '{}')).toMatchObject({ format: 'json', summaryToken: 'tok' });
  });

  test('Copy to notes sends the token and the draft version, says what was copied, and the AI notes section shows the stored entry', async ({ page }) => {
    await openWorkspace(page);
    await answerWith(page, (sourceId) => draftFor(sourceId));
    const copies: string[] = [];
    let stored = false;
    await page.route((url) => /\/draft\/ai-notes$/.test(url.pathname), async (route) => {
      if (route.request().method() === 'POST') {
        copies.push(route.request().postData() ?? '');
        stored = true;
        await route.fulfill({ json: { copied: 1, notCopied: 0, alreadyCopied: false, version: 2, save: { state: 'unsaved', savedAt: null } } });
        return;
      }
      await route.fulfill({ json: { entries: stored ? [{ tokenId: 't1', label: 'AI-drafted', model: 'stub-model', generatedAt: '2026-11-15T10:00:00.000Z', sentences: [{ text: 'Account AC-1 is an account.', citations: [{ kind: 'entity', ref: { sourceId: 'banking-demo', entityType: 'account', stableId: 'AC-1' }, title: 'Account AC-1', type: 'account' }] }], coverage: '1 shown · 0 not yet retrieved (exact)' }] : [], skipped: [] } });
    });
    await summarize(page).click();
    await panel(page).getByText('AI notes').click();
    await expect(panel(page).getByText('No AI notes are saved with this view.')).toBeVisible();
    await panel(page).getByRole('button', { name: 'Copy to notes' }).click();
    await expect(panel(page).getByText('1 sentence copied to notes.')).toBeVisible();
    expect(JSON.parse(copies[0] ?? '{}')).toMatchObject({ summaryToken: 'tok', version: expect.any(Number) });
    await expect(panel(page).getByText('Account AC-1 is an account.')).toBeVisible();
    await expect(panel(page).getByText('Rebuilt from your own access each time this view opens.')).toBeVisible();
  });

  const STATES: ReadonlyArray<readonly [string, (sourceId: string) => SummaryResponse, string]> = [
    ['partial', (sourceId) => draftFor(sourceId, { status: 'partial', removedCount: 1 }), '1 sentence removed: it could not be cited'],
    ['nothing supportable', () => summaryResponseSchema.parse({ status: 'unsupported', removedCount: 2, coverage: { retrieval: 'r', summary: 's' }, sent: SENT, model: 'm', calls: 2 }), 'No sentences had valid citations. No draft is available to copy.'],
    ['view too large', () => summaryResponseSchema.parse({ status: 'tooLarge', limit: 'elements', elements: 412, cap: 300 }), 'Narrow the current view before drafting. No data was submitted, including any partial selection.'],
    ['time limit', () => summaryResponseSchema.parse({ status: 'timeLimit', calls: 3 }), 'The draft took longer than the limit.'],
    ['error', () => summaryResponseSchema.parse({ status: 'failed', kind: 'unreachable', calls: 1 }), 'The model could not be reached.'],
  ];

  for (const [name, answer, text] of STATES) {
    test(`shows the ${name} state in its fixed words`, async ({ page }) => {
      await openWorkspace(page);
      await answerWith(page, answer);
      await summarize(page).click();
      await expect(panel(page).getByText(text)).toBeVisible();
    });
  }
});
