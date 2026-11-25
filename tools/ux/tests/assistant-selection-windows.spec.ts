import { expect, test, type Page } from '@playwright/test';
import type { AssistantTurnAnswer } from '@neburyx/contracts';

const STATUS = { ask: { available: true }, summary: { available: true }, assistant: { available: true, messageWords: 1000, model: 'claude-sonnet-5-5' } };
const EMPTY = { turns: [], earlierTurns: 0, previousThreadClearedAt: null };
const ANSWER: AssistantTurnAnswer = {
  status: 'answered',
  route: 'view',
  blocks: [{ kind: 'sentences', sentences: [{ text: 'AC-1 is the one account in view.', cites: ['n1'] }] }],
  citations: [{ key: 'n1', kind: 'entity', ref: { sourceId: 'banking-demo', entityType: 'account', stableId: 'AC-1' } }],
  coverage: { retrieval: '1 shown · 0 not yet retrieved (exact)', summary: 'The draft cites 1 of the 1 shown elements.' },
  model: 'claude-sonnet-5-5',
  calls: 2,
};

async function routes(page: Page): Promise<void> {
  await page.route((url) => url.pathname === '/v1/ai/status', (route) => route.fulfill({ json: STATUS }));
  await page.route((url) => /^\/v1\/assistant\/investigations\/[^/]+\/thread$/.test(url.pathname), (route) => route.fulfill({ json: EMPTY }));
  await page.route((url) => url.pathname === '/v1/assistant/turns', (route) => route.fulfill({ json: ANSWER }));
}

async function openAssistantPage(page: Page): Promise<string> {
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
  const id = /\/explore\/([0-9a-f-]{36})$/.exec(page.url())?.[1] ?? '';
  await page.getByRole('navigation').getByRole('link', { name: 'Home' }).click();
  await page.getByRole('link', { name: 'Assistant' }).click();
  await expect(page).toHaveURL(/\/assistant\/[0-9a-f-]{36}$/);
  await page.getByLabel('Your message').fill('what is in view?');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: /^Sources · 1/ }).click();
  return id;
}

test.describe('Select on graph across two windows', () => {
  test('highlights the element in the open graph window after it answers, and drops the highlight and the header chip when that window closes', async ({ page, context }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await routes(page);
    const id = await openAssistantPage(page);
    const graph = await context.newPage();
    await graph.goto(`/explore/${id}`);
    await expect(graph.getByText('1 entity · 0 relationships · loaded · exact')).toBeVisible();
    await expect(page.getByText('Graph window open')).toBeVisible();
    await page.getByRole('button', { name: /^Sources: 1,/ }).click();
    await expect(page.getByText('Highlighted in the graph window')).toBeVisible();
    await expect(graph.getByText('1 selected')).toBeVisible();
    await graph.close();
    await expect(page.getByText('Graph window open')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByText('Highlighted in the graph window')).toHaveCount(0);
  });

  test('says Selected with the notice when no graph window is open, and Open graph opens the investigation with the element selected', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await routes(page);
    const id = await openAssistantPage(page);
    await page.getByRole('button', { name: /^Sources: 1,/ }).click();
    await expect(page.getByText('No graph window is open for this investigation, so nothing was highlighted.')).toBeVisible();
    await page.getByRole('button', { name: 'Open graph' }).click();
    await expect(page).toHaveURL(new RegExp(`/explore/${id}$`));
    expect(page.url()).not.toContain('AC-1');
    await expect(page.getByText('1 selected')).toBeVisible();
  });
});
