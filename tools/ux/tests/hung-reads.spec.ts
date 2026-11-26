import { expect, test, type Page, type Route } from '@playwright/test';

const STATUS = { ask: { available: true }, summary: { available: true }, assistant: { available: true, messageWords: 1000, model: 'claude-sonnet-5-5' } };
const UNREACHABLE = 'The server could not be reached.';
/** Past the wait of a read of the application's own data, and past the longer wait of a search, which reads the source several times in a row. */
const PAST_A_READ = 16_000;
const PAST_A_SEARCH = 46_000;

/** A read that is never answered. */
const hang = (_route: Route): Promise<void> => new Promise(() => undefined);

const failureIn = (page: Page) => page.getByRole('main').getByText(UNREACHABLE);

async function openAssistantOf(page: Page): Promise<void> {
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
}

test.describe('a read that gets no answer', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install();
  });

  test('ends on the Investigations list in a failure with Try again', async ({ page }) => {
    await page.route((url) => url.pathname === '/v1/investigations', hang);
    await page.goto('/investigations');
    await expect(page.getByText('Loading investigations…')).toBeVisible();
    await page.clock.runFor(PAST_A_READ);
    await expect(failureIn(page)).toBeVisible();
    await expect(page.getByRole('main').getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.getByText('Loading investigations…')).toHaveCount(0);
  });

  test('ends on the patterns library in a failure with Try again', async ({ page }) => {
    await page.route((url) => url.pathname === '/v1/patterns', hang);
    await page.goto('/patterns');
    await expect(page.getByText('Loading saved patterns…')).toBeVisible();
    await page.clock.runFor(PAST_A_READ);
    const failure = page.getByRole('main').locator('.patterns-state[role="alert"]');
    await expect(failure.locator('p').first()).toHaveText(UNREACHABLE);
    await expect(failure.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    await expect(page.getByText('Loading saved patterns…')).toHaveCount(0);
  });

  test('of a search ends only after its longer wait, in a failure with Retry', async ({ page }) => {
    await page.route((url) => url.pathname === '/v1/search/entities', hang);
    await page.goto('/search?source=banking-demo');
    const box = page.getByRole('main').getByRole('textbox').or(page.getByRole('main').getByRole('searchbox')).first();
    await box.fill('AC-1');
    await box.press('Enter');
    await expect(page.getByRole('main').getByText('Searching…')).toBeVisible();
    await page.clock.runFor(PAST_A_READ);
    await expect(page.getByRole('main').getByText('Searching…')).toBeVisible();
    await page.clock.runFor(PAST_A_SEARCH - PAST_A_READ);
    await expect(failureIn(page)).toBeVisible();
    await expect(page.getByRole('main').getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('of the stored thread ends in a failure with Try again', async ({ page }) => {
    await page.route((url) => url.pathname === '/v1/ai/status', (route) => route.fulfill({ json: STATUS }));
    await page.route((url) => /^\/v1\/assistant\/investigations\/[^/]+\/thread$/.test(url.pathname), hang);
    await openAssistantOf(page);
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    await expect(page.getByText('Reading the earlier turns…')).toBeVisible();
    await page.clock.runFor(PAST_A_READ);
    await expect(page.getByText('Reading the earlier turns…')).toHaveCount(0);
    const failure = page.getByRole('alert').filter({ hasText: 'The earlier turns of this thread could not be read.' });
    await expect(failure).toHaveText('The earlier turns of this thread could not be read. Try again');
    await expect(failure.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  });
});
