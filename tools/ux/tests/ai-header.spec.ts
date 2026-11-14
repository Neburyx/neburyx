import { expect, test, type Page } from '@playwright/test';
import { canvasOf } from './support/workspace.ts';

const AI_PATH = /\/v1\/(ai|ask|assistant|summary)(\/|$|\?)/;

const header = (page: Page) => page.getByRole('banner', { name: 'Investigation' });
const control = (page: Page, label: 'Ask' | 'Summarize') => header(page).getByRole('button', { name: new RegExp(`^${label}`) });

async function openWorkspace(page: Page): Promise<void> {
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
}

async function answerAsEnterprise(page: Page): Promise<void> {
  await page.route((url) => url.pathname === '/v1/me', async (route) => {
    const answer = await route.fetch();
    await route.fulfill({ response: answer, json: { ...(await answer.json()), edition: 'enterprise' } });
  });
}

function countAiRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (AI_PATH.test(new URL(request.url()).pathname)) seen.push(`${request.method()} ${request.url()}`);
  });
  return seen;
}

test.describe('Summarize in the workspace header, and no Ask control while Ask is rebuilt', () => {
  test('are locked for a community build, with a padlock and no pill, and the same after a reload', async ({ page }) => {
    await openWorkspace(page);
    await expect(control(page, 'Summarize')).toHaveAttribute('aria-disabled', 'true');
    await expect(control(page, 'Summarize')).toHaveAccessibleName('Summarize, Enterprise capability, locked');
    await expect(control(page, 'Summarize')).toHaveAttribute('title', 'Enterprise capability, locked');
    await expect(control(page, 'Summarize').locator('svg rect')).toHaveCount(1);
    await expect(control(page, 'Ask')).toHaveCount(0);
    await expect(header(page).getByText('Enterprise', { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(control(page, 'Summarize')).toHaveAttribute('aria-disabled', 'true');
    await expect(control(page, 'Ask')).toHaveCount(0);
  });

  test('are unlocked for an enterprise build, and the same after a reload', async ({ page }) => {
    await answerAsEnterprise(page);
    await openWorkspace(page);
    await expect(control(page, 'Summarize')).toHaveAccessibleName('Summarize');
    await expect(control(page, 'Summarize')).not.toHaveAttribute('aria-disabled', 'true');
    await expect(control(page, 'Summarize').locator('svg rect')).toHaveCount(0);
    await expect(control(page, 'Ask')).toHaveCount(0);
    await page.reload();
    await expect(control(page, 'Summarize')).toHaveAccessibleName('Summarize');
    await expect(control(page, 'Ask')).toHaveCount(0);
  });

  test('sits beside the source status and Views without the header scrolling sideways, in both states', async ({ page }) => {
    for (const enterprise of [false, true]) {
      if (enterprise) await answerAsEnterprise(page);
      await openWorkspace(page);
      await expect(control(page, 'Summarize')).toBeVisible();
      const fits = await header(page).evaluate((element) => element.scrollWidth <= element.clientWidth);
      expect(fits, `the header fits (enterprise: ${enterprise})`).toBe(true);
      const placed = await header(page).evaluate((element) => {
        const follows = (before: Element | undefined, after: Element | undefined): boolean => before !== undefined && after !== undefined && (before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        const buttons = [...element.querySelectorAll('button')];
        const named = (start: string): Element | undefined => buttons.find((button) => button.textContent?.trim().startsWith(start));
        const source = element.querySelector('.header-source') ?? undefined;
        return { sourceThenSummarize: follows(source, named('Summarize')), summarizeThenViews: follows(named('Summarize'), named('Views')) };
      });
      expect(placed, `the order of the header (enterprise: ${enterprise})`).toEqual({ sourceThenSummarize: true, summarizeThenViews: true });
    }
  });

  test('send no request to an AI path when Summarize is activated by click, Enter or Space, locked or unlocked with nothing registered', async ({ page }) => {
    const seen = countAiRequests(page);
    for (const enterprise of [false, true]) {
      if (enterprise) await answerAsEnterprise(page);
      await openWorkspace(page);
      await control(page, 'Summarize').click({ force: true });
      await control(page, 'Summarize').focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      await expect(control(page, 'Summarize')).toBeFocused();
      if (enterprise) await expect(header(page).getByText('Summarize is not available in this release yet.')).toBeVisible();
      else await expect(header(page).getByText('is not available in this release yet.')).toHaveCount(0);
    }
    expect(seen).toEqual([]);
  });
});
