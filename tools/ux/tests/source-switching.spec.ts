import { expect, test, type Page } from '@playwright/test';
import { canvasOf, zoomOf } from './support/workspace.ts';

test.use({ baseURL: 'http://127.0.0.1:4175' });

const sourceLine = (page: Page) => page.locator('section[aria-label="Source"]');
const heading = (page: Page) => page.getByRole('heading', { level: 1 });

async function openIn(page: Page, source: string, stableId: string, caseRef?: string): Promise<void> {
  await page.getByRole('button', { name: source, exact: true }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill(stableId);
  if (caseRef !== undefined) await form.getByLabel('Case reference (optional)').fill(caseRef);
  await form.getByRole('button', { name: 'Open' }).click();
}

function recording(page: Page): { readonly seen: string[]; readonly metadata: string[] } {
  const seen: string[] = [];
  const metadata: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    const line = `${request.method()} ${pathname.replace(/[0-9a-f-]{36}/, ':id')}`;
    if (pathname.startsWith('/v1/investigations') || pathname.startsWith('/v1/entities')) seen.push(line);
    else if (pathname.startsWith('/v1/')) metadata.push(line);
  });
  return { seen, metadata };
}

test.describe('opening an entity of a second source while an investigation of the first is open', () => {
  const caseRef = () => `CASE-SW-${Date.now()}`;

  test('shows the second source and its investigation, and moves by Back and Forward with no read', async ({ page }) => {
    const requests = recording(page);
    await page.goto('/dev/open-entity');
    await openIn(page, 'banking-demo', 'AC-1', caseRef());
    await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
    await expect(heading(page)).toHaveText('account AC-1');
    await expect(sourceLine(page)).toContainText('banking-demo');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');

    await page.goBack();
    await expect(page).toHaveURL(/\/dev\/open-entity$/);
    await expect(sourceLine(page)).toContainText('banking-demo');
    await expect(page.locator('.page-heading .source-note')).toContainText('banking-demo');

    await openIn(page, 'claims-demo', 'CL-1');
    await expect(heading(page)).toHaveText('account CL-1');
    await expect(sourceLine(page)).toContainText('claims-demo');
    await expect(sourceLine(page)).not.toContainText('banking-demo');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');

    requests.seen.length = 0;
    requests.metadata.length = 0;
    await page.goBack();
    await expect(page).toHaveURL(/\/dev\/open-entity$/);
    await expect(page.locator('.page-heading .source-note')).toContainText('claims-demo');
    await page.goForward();
    await expect(heading(page)).toHaveText('account CL-1');
    await expect(sourceLine(page)).toContainText('claims-demo');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
    expect(requests.seen, 'moving by Back and Forward reads no investigation and no entity').toEqual([]);
    expect(requests.metadata, 'and nothing about the sources either, the source being the same').toEqual([]);
  });

  test('brings the first investigation back when its case reference is opened again, with that open’s own request and nothing else', async ({ page }) => {
    const requests = recording(page);
    const reference = caseRef();
    await page.goto('/dev/open-entity');
    await openIn(page, 'banking-demo', 'AC-2', reference);
    await expect(heading(page)).toHaveText('account AC-2');
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await expect.poll(() => zoomOf(page), { message: 'both steps of the zoom have landed' }).toBeLessThan(0.7);
    const left = await zoomOf(page);
    await page.goBack();
    await openIn(page, 'claims-demo', 'CL-2');
    await expect(sourceLine(page)).toContainText('claims-demo');
    await page.goBack();
    requests.seen.length = 0;
    requests.metadata.length = 0;
    await openIn(page, 'banking-demo', 'AC-2', reference);
    await expect(heading(page)).toHaveText('account AC-2');
    await expect(sourceLine(page)).toContainText('banking-demo');
    await expect(page.locator('.status-strip')).toHaveText('An existing investigation for this case reference was opened.');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
    await expect.poll(() => zoomOf(page), { message: 'the zoom the first investigation was left with comes back, not a new fit' }).toBeCloseTo(left, 5);
    expect(requests.seen).toEqual(['POST /v1/investigations']);
    expect(requests.metadata, 'the form reads the profile of the source it opens in, and the app reads it again as the source in view changes back').toEqual(['GET /v1/sources/banking-demo/profile', 'GET /v1/sources/banking-demo/profile']);
  });

  test('names the second source in a failed open, keeps the first in the status line and heading, and returns to the first investigation as it was', async ({ page }) => {
    await page.goto('/dev/open-entity');
    await openIn(page, 'banking-demo', 'AC-3', caseRef());
    await expect(heading(page)).toHaveText('account AC-3');
    await page.goBack();
    await openIn(page, 'claims-demo', 'missing');
    const failure = page.getByRole('group', { name: 'Opening failed' });
    await expect(failure).toContainText('NOT_FOUND');
    await expect(failure).toContainText('Could not open in claims-demo.');
    await expect(sourceLine(page)).toContainText('banking-demo');
    await expect(page.locator('.page-heading .source-note')).toContainText('banking-demo');
    await page.goForward();
    await expect(heading(page)).toHaveText('account AC-3');
    await expect(sourceLine(page)).toContainText('banking-demo');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
  });

  test('reads the second investigation after a reload and the first only when it is opened, and then draws only its starting entity', async ({ page }) => {
    const requests = recording(page);
    const reference = caseRef();
    await page.goto('/dev/open-entity');
    await openIn(page, 'banking-demo', 'AC-4', reference);
    await expect(heading(page)).toHaveText('account AC-4');
    await page.goBack();
    await openIn(page, 'claims-demo', 'CL-4');
    await expect(heading(page)).toHaveText('account CL-4');
    requests.seen.length = 0;
    await page.reload();
    await expect(heading(page)).toHaveText('account CL-4');
    await expect(sourceLine(page)).toContainText('claims-demo');
    expect(requests.seen).toEqual(['GET /v1/investigations/:id', 'GET /v1/entities/claims-demo/account/CL-4']);
    requests.seen.length = 0;
    await page.goto('/dev/open-entity');
    await openIn(page, 'banking-demo', 'AC-4', reference);
    await expect(heading(page)).toHaveText('account AC-4');
    await expect(sourceLine(page)).toContainText('banking-demo');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
    expect(requests.seen).toEqual(['POST /v1/investigations']);
  });
});
