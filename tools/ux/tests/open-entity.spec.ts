import { expect, test } from '@playwright/test';
import { canvasOf, drawing, zoomOf } from './support/workspace.ts';

test.describe('opening an entity from the development page', () => {
  test('draws the one entity in Explore with the title in the header, and draws it again from the address after a reload', async ({ page }) => {
    await page.goto('/dev/open-entity');
    await page.getByRole('button', { name: 'banking-demo' }).click();
    const form = page.getByRole('form', { name: 'Open an entity' });
    await form.getByLabel('Stable ID').fill('AC-1');
    await form.getByRole('button', { name: 'Open' }).click();

    await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('account AC-1');
    await expect(page.getByText('Unsaved')).toBeVisible();
    await expect(page.getByText('1 entity · 0 relationships · loaded · exact')).toBeVisible();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
    expect(await zoomOf(page), 'a lone entity is fitted at 100%, not larger').toBeCloseTo(1, 5);
    await expect.poll(async () => (await drawing(page)).nodes.map((node) => node.captionShown && node.glyphShown), { message: 'the caption and the glyph are drawn at 100%' }).toEqual([true]);

    const address = page.url();
    await page.reload();
    await expect(page).toHaveURL(address);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('account AC-1');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
  });

  for (const id of ['.', '..']) {
    test(`opens an entity whose stable ID is "${id}" and draws it again from the address after a reload`, async ({ page }) => {
      const requested: string[] = [];
      const referenced: string[] = [];
      page.on('request', (request) => {
        if (request.url().includes('/v1/entities/')) requested.push(new URL(request.url()).pathname);
        if (request.url().includes('/v1/graph/read-refs')) referenced.push(request.postData() ?? '');
      });
      await page.goto('/dev/open-entity');
      await page.getByRole('button', { name: 'banking-demo' }).click();
      const form = page.getByRole('form', { name: 'Open an entity' });
      await form.getByLabel('Stable ID').fill(id);
      await form.getByRole('button', { name: 'Open' }).click();
      await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(`account ${id}`);
      await page.reload();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(`account ${id}`);
      await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
      const byPath = requested.includes(`/v1/entities/banking-demo/account/~${id}`);
      const byBody = referenced.some((body) => JSON.parse(body).entities.some((entity: { stableId: string }) => entity.stableId === id));
      expect(byPath || byBody, 'the reload read the entity by a path no URL parser shortens, or by a reference in a body').toBe(true);
    });
  }

  test('draws nothing and says why for an entity the source does not hold, and keeps the form as typed', async ({ page }) => {
    await page.goto('/dev/open-entity');
    await page.getByRole('button', { name: 'banking-demo' }).click();
    const form = page.getByRole('form', { name: 'Open an entity' });
    await form.getByLabel('Stable ID').fill('missing');
    await form.getByRole('button', { name: 'Open' }).click();
    await expect(page.getByRole('group', { name: 'Opening failed' })).toContainText('NOT_FOUND');
    await expect(form.getByLabel('Stable ID')).toHaveValue('missing');
    await expect(page).toHaveURL(/\/dev\/open-entity$/);
  });

  test('shows a not-found page with a way back to Home for an investigation that does not exist', async ({ page }) => {
    await page.goto('/explore/0192f000-0000-7000-8000-0000000000ee');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Investigation not found');
    await page.getByRole('link', { name: 'Back to Home' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('tells that an existing investigation was resumed, in a grey status line that is not a failure', async ({ page }) => {
    await page.goto('/dev/open-entity');
    await page.getByRole('button', { name: 'banking-demo' }).click();
    const form = page.getByRole('form', { name: 'Open an entity' });
    const reference = `CASE-7-${Date.now()}`;
    const openAgain = async (): Promise<void> => {
      await form.getByLabel('Stable ID').fill('AC-2');
      await form.getByLabel('Case reference (optional)').fill(reference);
      await form.getByRole('button', { name: 'Open' }).click();
    };
    await openAgain();
    await expect(page).toHaveURL(/\/explore\//);
    await page.goBack();
    await page.getByRole('button', { name: 'banking-demo' }).click();
    await openAgain();
    const strip = page.locator('.status-strip');
    await expect(strip).toHaveText('An existing investigation for this case reference was opened.');
    expect(await strip.evaluate((element) => getComputedStyle(element).backgroundColor), 'not the red of a failure').not.toBe('rgb(251, 236, 238)');
    await expect(page.locator('.notice-strip')).toHaveCount(0);
  });

});
