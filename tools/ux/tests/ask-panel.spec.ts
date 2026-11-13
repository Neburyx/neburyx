import { expect, test } from '@playwright/test';
import { askControl, askField, askPanel, openAsk, previewQuestion, scriptAsk } from './support/ask-panel.ts';

test.describe('the Ask panel', () => {
  test('opens from the header with the field in focus, and closes with Escape and gives the focus back to the control', async ({ page }) => {
    await scriptAsk(page);
    await openAsk(page);
    await expect(askPanel(page).getByRole('heading', { level: 2, name: 'Ask' })).toBeVisible();
    await expect(askField(page)).toBeFocused();
    await expect(askPanel(page).getByText("Don't type customer names; others may see this text.")).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(askPanel(page)).toHaveCount(0);
    await expect(askControl(page)).toBeFocused();
  });

  test('shows exactly the text the server returned as the preview, and a Send that carries its hash', async ({ page }) => {
    const seen = await scriptAsk(page);
    await openAsk(page);
    await previewQuestion(page, 'Which accounts share the same device as this one?');
    const card = askPanel(page).getByRole('region', { name: 'What the model will receive' });
    await expect(card.locator('pre')).toHaveText('Which accounts share the same device as ‹account#1›?');
    await expect(card.getByText('Names and IDs are replaced with placeholders. Your typed text is never sent, only these words.')).toBeVisible();
    expect(seen.bodies.map((body) => body.send)).toEqual([false]);
    await card.getByRole('button', { name: 'Send' }).click();
    await expect(askPanel(page).getByRole('status')).toHaveText('Not answered · refused');
    const refusal = askPanel(page).getByRole('region', { name: 'This question was not answered' });
    await expect(refusal).toContainText('Ask has no way to answer this question.');
    await expect(refusal.getByRole('button', { name: 'Search by stable ID' })).toBeVisible();
    expect(seen.bodies[1]).toMatchObject({ send: true, previewHash: 'a'.repeat(64) });
  });

  test('marks a blocked word, says it was not sent, offers no Send, and sends no request with send true', async ({ page }) => {
    const seen = await scriptAsk(page);
    await openAsk(page);
    await previewQuestion(page, 'Which zorvat shares a device?');
    await expect(askPanel(page).locator('mark.ask-blocked')).toHaveText('zorvat');
    await expect(askPanel(page).getByRole('heading', { level: 3, name: "“zorvat” can't be sent to the model" })).toBeVisible();
    await expect(askPanel(page).getByRole('status')).toHaveText('Not sent · 1 word needs attention');
    await expect(askPanel(page).getByRole('button', { name: /send/i })).toHaveCount(0);
    await page.keyboard.press('Enter');
    expect(seen.bodies.every((body) => body.send === false)).toBe(true);
  });

  test('reaches the controls of the blocked card by Tab in reading order', async ({ page }) => {
    await scriptAsk(page);
    await openAsk(page);
    await previewQuestion(page, 'Which zorvat shares a device?');
    await expect(askPanel(page).getByRole('heading', { level: 3, name: "“zorvat” can't be sent to the model" })).toBeVisible();
    await askField(page).focus();
    const names: string[] = [];
    for (let press = 0; press < 5; press += 1) {
      await page.keyboard.press('Tab');
      names.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? ''));
    }
    expect(names).toEqual(['Preview', 'Pick an entity', 'Use as a search value', 'Remove the word', 'Edit question']);
  });

  test('asks which one fits, and a chip asks for a new preview with the pick', async ({ page }) => {
    const seen = await scriptAsk(page);
    await openAsk(page);
    const question = 'Which accounts share a device with Qux?';
    await previewQuestion(page, question);
    await expect(askPanel(page).getByRole('heading', { level: 3, name: 'Do you mean…?' })).toBeVisible();
    await expect(askPanel(page).getByRole('status')).toHaveText('Awaiting clarification · no plan run');
    await askPanel(page).getByRole('button', { name: 'account · AC-2' }).click();
    await expect(askPanel(page).getByRole('region', { name: 'What the model will receive' })).toBeVisible();
    expect(seen.bodies[1]?.resolutions).toEqual([{ start: question.indexOf('Qux'), end: question.indexOf('Qux') + 3, ref: { sourceId: 'banking-demo', entityType: 'account', stableId: 'AC-2' } }]);
  });

  test('stays inside the window and does not make the page scroll sideways', async ({ page }) => {
    await scriptAsk(page);
    await openAsk(page);
    await previewQuestion(page, 'Which zorvat shares a device?');
    const box = await askPanel(page).boundingBox();
    const size = page.viewportSize();
    expect(box).not.toBeNull();
    if (box === null || size === null) return;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(size.width);
    expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test('lists the saved patterns that will go with the question, with their structure and the names that passed, after the question text', async ({ page }) => {
    await scriptAsk(page);
    await openAsk(page);
    await previewQuestion(page, 'Which accounts match my saved pattern?');
    const card = askPanel(page).getByRole('region', { name: 'What the model will receive' });
    await expect(card.locator('pre').first()).toHaveText('Which accounts match my saved pattern for ‹account#1›?');
    await expect(card.getByRole('heading', { level: 4, name: 'Saved patterns listed for the model' })).toBeVisible();
    const patterns = card.getByLabel('Saved patterns listed for the model');
    await expect(patterns).toContainText('pat_1, named "Accounts that pay each other"');
    await expect(patterns).toContainText('pat_2: starts at a held entity of type account');
    await expect(card.getByRole('button', { name: 'Send' })).toBeVisible();
    const shot = process.env['NEBURYX_UX_SHOT'];
    if (shot !== undefined) await page.screenshot({ path: shot });
  });
});
