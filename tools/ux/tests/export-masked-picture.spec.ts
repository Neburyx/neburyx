import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Request } from '@playwright/test';
import { canvasOf } from './support/workspace.ts';

const SIGNATURE = '89504e470d0a1a0a';
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Export current view' });

test('a picture exported with Mask critical fields on and the session switch off is drawn from masked items, and the session is left as it was', async ({ page }) => {
  await page.goto('/banking-demo/entity/customer/pii-1');
  await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
  const sent: Request[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' || request.url().includes('/v1/entities/')) sent.push(request);
  });

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await dialog(page).getByRole('radio', { name: 'PNG' }).check();
  const mask = dialog(page).getByRole('button', { name: 'Mask critical fields' });
  await mask.focus();
  await page.keyboard.press('Space');
  await expect(mask).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog(page).getByText('masking: on · the picture states how many fields are masked')).toBeVisible();

  const download = page.waitForEvent('download');
  await dialog(page).getByRole('button', { name: 'Download PNG (masked)' }).click();
  const file = await download;
  const bytes = await readFile(await file.path());
  expect(bytes.subarray(0, 8).toString('hex')).toBe(SIGNATURE);

  const bodies = sent.filter((request) => request.method() === 'POST').map((request) => ({ url: new URL(request.url()).pathname, body: request.postDataJSON() }));
  const exported = bodies.find((entry) => entry.url.endsWith('/exports'));
  const read = bodies.find((entry) => entry.url === '/v1/graph/read-refs');
  expect(exported?.body).toMatchObject({ format: 'png', mask: true });
  expect(read?.body).toMatchObject({ mask: true });
  expect(sent.some((request) => request.url().includes('/v1/entities/'))).toBe(false);
  await expect(dialog(page)).toHaveCount(0);
  await canvasOf(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await page.getByRole('complementary', { name: 'Inspector' }).getByRole('tab', { name: 'Properties' }).click();
  await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('switch', { name: 'Mask sensitive values' })).not.toBeChecked();
  await expect(page.getByRole('complementary', { name: 'Inspector' }).getByText('Ana Silva').first()).toBeVisible();
});
