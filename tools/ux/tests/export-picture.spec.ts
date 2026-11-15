import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { canvasOf, openSample } from './support/workspace.ts';

const MAX_EDGE = 8192;
const MAX_AREA = 16_777_216;
const SIGNATURE = '89504e470d0a1a0a';

const exportButton = (page: Page) => page.getByRole('button', { name: 'Export', exact: true });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Export current view' });
const mode = (page: Page, value: 'ok' | 'not-found') => page.request.post('/__support/export-mode', { data: { mode: value } });

test.afterEach(async ({ page }) => {
  await mode(page, 'ok');
});

async function openInvestigation(page: Page): Promise<void> {
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
}

async function chosenPng(page: Page): Promise<void> {
  await exportButton(page).click();
  await dialog(page).getByRole('radio', { name: 'PNG' }).check();
}

/** How many pixels of a region differ from the canvas colour, read back in the page. */
async function inkIn(page: Page, bytes: Buffer, region: { readonly top: number; readonly height: number }): Promise<{ readonly width: number; readonly height: number; readonly ink: number }> {
  return page.evaluate(
    async ({ data, area }) => {
      const blob = new Blob([Uint8Array.from(atob(data), (character) => character.charCodeAt(0))], { type: 'image/png' });
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('no canvas');
      context.drawImage(bitmap, 0, 0);
      const top = area.top < 0 ? bitmap.height + area.top : area.top;
      const pixels = context.getImageData(0, top, bitmap.width, Math.min(area.height, bitmap.height - top)).data;
      let ink = 0;
      for (let index = 0; index < pixels.length; index += 4) if (Math.abs((pixels[index] ?? 0) - 250) > 12 || Math.abs((pixels[index + 1] ?? 0) - 251) > 12 || Math.abs((pixels[index + 2] ?? 0) - 252) > 12) ink += 1;
      return { width: bitmap.width, height: bitmap.height, ink };
    },
    { data: bytes.toString('base64'), area: region },
  );
}

test.describe('exporting the current view as a picture', () => {
  test.beforeEach(async ({ page }) => {
    await openInvestigation(page);
  });

  test('downloads a PNG within the size bounds, with the header band and the drawing both on it', async ({ page }) => {
    await chosenPng(page);
    const download = page.waitForEvent('download');
    await dialog(page).getByRole('button', { name: 'Download PNG' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^neburyx-export-\d{8}T\d{6}Z\.png$/);
    const path = await file.path();
    const bytes = await readFile(path);
    expect(bytes.subarray(0, 8).toString('hex')).toBe(SIGNATURE);
    const band = await inkIn(page, bytes, { top: 0, height: 100 });
    expect(band.width).toBeGreaterThan(0);
    expect(band.height).toBeGreaterThan(0);
    expect(Math.max(band.width, band.height)).toBeLessThanOrEqual(MAX_EDGE);
    expect(band.width * band.height).toBeLessThanOrEqual(MAX_AREA);
    expect(band.ink).toBeGreaterThan(0);
    const drawing = await inkIn(page, bytes, { top: 160, height: band.height - 160 });
    expect(drawing.ink).toBeGreaterThan(0);
    await expect(dialog(page)).toHaveCount(0);
  });

  test('sends the references of exactly what the canvas draws', async ({ page }) => {
    const drawn = Number(await canvasOf(page).getAttribute('data-drawn-entities'));
    await chosenPng(page);
    const request = page.waitForRequest((candidate) => candidate.method() === 'POST' && /\/exports$/.test(candidate.url()));
    await dialog(page).getByRole('button', { name: 'Download PNG' }).click();
    const body = (await request).postDataJSON() as { readonly format: string; readonly entities: readonly unknown[] };
    expect(body.format).toBe('png');
    expect(body.entities).toHaveLength(drawn);
  });

  test('shows the refusal and downloads nothing when the export is refused', async ({ page }) => {
    await mode(page, 'not-found');
    await chosenPng(page);
    let downloads = 0;
    page.on('download', () => void (downloads += 1));
    await dialog(page).getByRole('button', { name: 'Download PNG' }).click();
    await expect(dialog(page).getByRole('status').filter({ hasText: /\S/ })).toBeVisible();
    await expect(dialog(page).getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(downloads).toBe(0);
  });
});

test.describe('exporting a view with an entity filtered out', () => {
  async function pictureOfTheView(page: Page): Promise<{ readonly ids: readonly string[]; readonly bytes: Buffer }> {
    await chosenPng(page);
    const download = page.waitForEvent('download');
    await dialog(page).getByRole('button', { name: 'Download PNG' }).click();
    const bytes = await readFile(await (await download).path());
    const sent = await page.evaluate(() => Reflect.get(window, 'sampleExportRequests') as readonly { readonly entities: readonly { readonly stableId: string }[] }[]);
    const last = sent.at(-1);
    return { ids: (last?.entities ?? []).map((entity) => entity.stableId).sort(), bytes };
  }

  test('leaves the filtered-out entities out of the request and out of the picture', async ({ page }) => {
    await openSample(page, '?export=on');
    const full = await pictureOfTheView(page);
    expect(full.ids).toHaveLength(10);
    await page.getByRole('group', { name: 'Tools' }).getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('group', { name: 'Entity types' }).getByRole('button').first().click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '8');
    const filtered = await pictureOfTheView(page);
    expect(filtered.ids).toHaveLength(8);
    const hidden = full.ids.filter((id) => !filtered.ids.includes(id));
    expect(hidden).toHaveLength(2);
    for (const id of hidden) expect(filtered.ids).not.toContain(id);
    expect(filtered.bytes.equals(full.bytes)).toBe(false);
    const whole = await inkIn(page, full.bytes, { top: 160, height: 8000 });
    const narrowed = await inkIn(page, filtered.bytes, { top: 160, height: 8000 });
    expect(narrowed.ink).toBeLessThan(whole.ink);
  });
});

test.describe('exporting a picture on a high-density screen', () => {
  test('is exactly as large as on a normal screen, and within the size bounds', async ({ browser, baseURL, viewport }) => {
    const sizes: { readonly width: number; readonly height: number }[] = [];
    for (const deviceScaleFactor of [1, 2]) {
      const context = await browser.newContext({ deviceScaleFactor, ...(baseURL === undefined ? {} : { baseURL }), ...(viewport === null ? {} : { viewport }) });
      const page = await context.newPage();
      expect(await page.evaluate(() => window.devicePixelRatio)).toBe(deviceScaleFactor);
      await openInvestigation(page);
      await chosenPng(page);
      const download = page.waitForEvent('download');
      await dialog(page).getByRole('button', { name: 'Download PNG' }).click();
      const { width, height } = await inkIn(page, await readFile(await (await download).path()), { top: 0, height: 10 });
      expect(Math.max(width, height)).toBeLessThanOrEqual(MAX_EDGE);
      expect(width * height).toBeLessThanOrEqual(MAX_AREA);
      sizes.push({ width, height });
      await context.close();
    }
    expect(Math.abs((sizes[0]?.width ?? 0) - (sizes[1]?.width ?? 1))).toBeLessThanOrEqual(1);
    expect(Math.abs((sizes[0]?.height ?? 0) - (sizes[1]?.height ?? 1))).toBeLessThanOrEqual(1);
  });
});
