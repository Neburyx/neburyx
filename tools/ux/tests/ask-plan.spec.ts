import { expect, test } from '@playwright/test';
import { askPanel, scriptAsk } from './support/ask-panel.ts';
import { canvasOf } from './support/workspace.ts';
import { NEW_PLAN_ID, PLAN_ID, openPlanCard, scriptPlan } from './support/ask-plan.ts';

const card = (page: import('@playwright/test').Page) => askPanel(page).getByRole('region', { name: 'Review before running' });

test.describe('the plan card of the Ask panel', () => {
  test('shows the plan to review, with the read-only line and the three buttons, and runs nothing until Run', async ({ page }) => {
    await scriptAsk(page);
    const seen = await scriptPlan(page);
    await openPlanCard(page);
    await expect(card(page).getByText('Shared attribute')).toBeVisible();
    await expect(card(page).getByText('Read-only · same limits as manual exploration')).toBeVisible();
    await expect(card(page).getByRole('button')).toHaveText(['Run', 'Edit', 'Cancel']);
    await page.waitForTimeout(300);
    expect(seen.calls).toEqual([]);
  });

  test('runs the plan on Run and says what ran and how it ended, with the count and its label', async ({ page }) => {
    await scriptAsk(page);
    const seen = await scriptPlan(page);
    await openPlanCard(page);
    await card(page).getByRole('button', { name: 'Run' }).click();
    await expect(card(page).getByText(/^Ran shared-attribute · \d+\.\d\d s · complete$/)).toBeVisible();
    await expect(card(page).getByText('1 · exact')).toBeVisible();
    expect(seen.calls.map((call) => call.path)).toEqual(['/v1/ask/run']);
    expect(seen.calls[0]?.body).toMatchObject({ planId: PLAN_ID });
  });

  test('stops as heavy with the estimate and Continue, and continues with the token it was given', async ({ page }) => {
    await scriptAsk(page);
    const seen = await scriptPlan(page, 'heavy');
    await openPlanCard(page);
    await card(page).getByRole('button', { name: 'Run' }).click();
    await expect(card(page).getByText('≥ 500 · lower bound')).toBeVisible();
    await card(page).getByRole('button', { name: 'Continue' }).click();
    await expect(card(page).getByText(/^Ran shared-attribute/)).toBeVisible();
    expect(seen.calls[1]?.body).toMatchObject({ planId: PLAN_ID, continue: true, continueToken: 'c'.repeat(64) });
  });

  test('says the plan expired, with Ask again that returns to the preview', async ({ page }) => {
    await scriptAsk(page);
    await scriptPlan(page, 'expired');
    await openPlanCard(page);
    await card(page).getByRole('button', { name: 'Run' }).click();
    await expect(card(page).getByText('This plan expired. Ask the question again.')).toBeVisible();
    await card(page).getByRole('button', { name: 'Ask again' }).click();
    await expect(askPanel(page).getByRole('region', { name: 'What the model will receive' })).toBeVisible();
    await expect(askPanel(page).getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  test('edits a parameter, shows the new plan for review and runs the new plan', async ({ page }) => {
    await scriptAsk(page);
    const seen = await scriptPlan(page);
    await openPlanCard(page);
    await card(page).getByRole('button', { name: 'Edit' }).click();
    await card(page).getByRole('textbox', { name: 'Limit' }).fill('10');
    await card(page).getByRole('button', { name: 'Save' }).click();
    await expect(card(page).getByText('The plan was changed. Nothing has run.')).toBeVisible();
    await card(page).getByRole('button', { name: 'Run' }).click();
    expect(seen.calls.map((call) => call.path)).toEqual(['/v1/ask/edit', '/v1/ask/run']);
    expect(seen.calls[1]?.body).toMatchObject({ planId: NEW_PLAN_ID });
  });

  test('cancels the plan, says nothing ran and leaves no buttons', async ({ page }) => {
    await scriptAsk(page);
    const seen = await scriptPlan(page);
    await openPlanCard(page);
    await card(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(card(page).getByText('Plan cancelled. Nothing ran.')).toBeVisible();
    await expect(card(page).getByRole('button')).toHaveCount(0);
    expect(seen.calls.map((call) => call.path)).toEqual(['/v1/ask/cancel']);
  });

  test('stays inside the window in every state and does not make the page scroll sideways', async ({ page }) => {
    await scriptAsk(page);
    await scriptPlan(page);
    await openPlanCard(page);
    for (const step of ['review', 'edit', 'result']) {
      if (step === 'edit') await card(page).getByRole('button', { name: 'Edit' }).click();
      if (step === 'result') {
        await card(page).getByRole('button', { name: 'Back' }).click();
        await card(page).getByRole('button', { name: 'Run' }).click();
        await expect(card(page).getByText(/^Ran /)).toBeVisible();
      }
      const box = await askPanel(page).boundingBox();
      const size = page.viewportSize();
      expect(box).not.toBeNull();
      if (box === null || size === null) return;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    }
  });

  test('draws the answer under the result with its markers and sources, says why a marker cannot select, and stays inside the window', async ({ page }) => {
    await scriptAsk(page);
    await scriptPlan(page, 'summary');
    await openPlanCard(page);
    await card(page).getByRole('button', { name: 'Run' }).click();
    const answer = card(page).getByRole('region', { name: 'Answer' });
    await expect(answer.getByText('1 shown.')).toBeVisible();
    await expect(answer.getByRole('button', { name: /^Source 1:/ })).toBeVisible();
    await answer.getByRole('button', { name: /^Source 2:/ }).click();
    await expect(answer.getByText('It is not on the graph yet. Use Add to graph first.')).toBeVisible();
    // once the result is on the graph, a marker selects its element, and the canvas read-out says so
    await card(page).getByRole('button', { name: 'Add to graph' }).click();
    await answer.getByRole('button', { name: /^Source 1:/ }).first().click();
    await expect.poll(async () => canvasOf(page).evaluate((element) => document.getElementById(element.getAttribute('aria-describedby') ?? '')?.textContent ?? '')).toMatch(/1 selected/);
    const toggle = answer.getByRole('button', { name: '2 sources' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(answer.getByRole('listitem').filter({ hasText: /account AC-2$/ })).toBeVisible();
    const box = await askPanel(page).boundingBox();
    const size = page.viewportSize();
    expect(box).not.toBeNull();
    if (box === null || size === null) return;
    expect(box.x + box.width).toBeLessThanOrEqual(size.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});
