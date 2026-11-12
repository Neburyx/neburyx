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

test.describe('Ask and Summarize in the workspace header', () => {
  test('are locked for a community build, with a padlock and no pill, and the same after a reload', async ({ page }) => {
    await openWorkspace(page);
    for (const label of ['Ask', 'Summarize'] as const) {
      await expect(control(page, label)).toHaveAttribute('aria-disabled', 'true');
      await expect(control(page, label)).toHaveAccessibleName(`${label}, Enterprise capability, locked`);
      await expect(control(page, label)).toHaveAttribute('title', 'Enterprise capability, locked');
      await expect(control(page, label).locator('svg rect')).toHaveCount(1);
    }
    await expect(header(page).getByText('Enterprise', { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(control(page, 'Ask')).toHaveAttribute('aria-disabled', 'true');
  });

  test('are unlocked for an enterprise build, and the same after a reload', async ({ page }) => {
    await answerAsEnterprise(page);
    await openWorkspace(page);
    for (const label of ['Ask', 'Summarize'] as const) {
      await expect(control(page, label)).toHaveAccessibleName(label);
      await expect(control(page, label)).not.toHaveAttribute('aria-disabled', 'true');
      await expect(control(page, label).locator('svg rect')).toHaveCount(0);
    }
    await page.reload();
    await expect(control(page, 'Summarize')).toHaveAccessibleName('Summarize');
  });

  test('sit beside the source status and Views without the header scrolling sideways, in both states', async ({ page }) => {
    for (const enterprise of [false, true]) {
      if (enterprise) await answerAsEnterprise(page);
      await openWorkspace(page);
      await expect(control(page, 'Ask')).toBeVisible();
      const fits = await header(page).evaluate((element) => element.scrollWidth <= element.clientWidth);
      expect(fits, `the header fits (enterprise: ${enterprise})`).toBe(true);
      const placed = await header(page).evaluate((element) => {
        const follows = (before: Element | undefined, after: Element | undefined): boolean => before !== undefined && after !== undefined && (before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        const buttons = [...element.querySelectorAll('button')];
        const named = (start: string): Element | undefined => buttons.find((button) => button.textContent?.trim().startsWith(start));
        const source = element.querySelector('.header-source') ?? undefined;
        return { sourceThenAsk: follows(source, named('Ask')), askThenSummarize: follows(named('Ask'), named('Summarize')), summarizeThenViews: follows(named('Summarize'), named('Views')) };
      });
      expect(placed, `the order of the header (enterprise: ${enterprise})`).toEqual({ sourceThenAsk: true, askThenSummarize: true, summarizeThenViews: true });
    }
  });

  test('send no request to an AI path when activated by click, Enter or Space, locked or unlocked with nothing registered', async ({ page }) => {
    const seen = countAiRequests(page);
    for (const enterprise of [false, true]) {
      if (enterprise) await answerAsEnterprise(page);
      await openWorkspace(page);
      for (const label of ['Ask', 'Summarize'] as const) {
        await control(page, label).click({ force: true });
        await control(page, label).focus();
        await page.keyboard.press('Enter');
        await page.keyboard.press('Space');
        await expect(control(page, label)).toBeFocused();
      }
      if (enterprise) await expect(header(page).getByText('Summarize is not available in this release yet.')).toBeVisible();
      else await expect(header(page).getByText('is not available in this release yet.')).toHaveCount(0);
    }
    expect(seen).toEqual([]);
  });
});
