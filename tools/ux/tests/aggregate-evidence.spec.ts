import { expect, test, type Page } from '@playwright/test';
import { canvasOf, drawing, menuItems, menuOf, openSample, screenOf } from './support/workspace.ts';

const panel = (page: Page) => page.getByRole('complementary', { name: 'Relationship evidence' });

async function rightClickBetween(page: Page, from: string, to: string): Promise<void> {
  const a = await screenOf(page, from);
  const b = await screenOf(page, to);
  await page.mouse.click((a.x + b.x) / 2, (a.y + b.y) / 2, { button: 'right' });
  await expect(menuOf(page)).toHaveCount(1);
}

test.describe('the evidence of an aggregate relationship', () => {
  test('is drawn as a bold relationship labelled with its type and count, as frame 74 draws it up to the quality label', async ({ page }) => {
    await openSample(page);
    const bold = (await drawing(page)).edges.filter((edge) => edge.width === 3.5);
    expect(bold.map((edge) => edge.label)).toEqual(['USES_GADGET · 42 · exact']);
  });

  test('opens from the relationship menu with the keyboard, shows its own count of all members beside the canvas label of the drawn ones, the dates and the sample with no link, and Esc closes it with the focus back on the canvas', async ({ page }) => {
    await openSample(page, '?evidence=on');
    expect((await drawing(page)).edges.filter((edge) => edge.width === 3.5).map((edge) => edge.label)).toEqual(['USES_GADGET · 42 · exact']);
    await rightClickBetween(page, 'led-1', 'gad-1');
    expect(await menuItems(page)).toEqual(expect.arrayContaining(['Why is this relationship here?', 'View supporting records']));
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByText('Aggregate relationship')).toBeVisible();
    await expect(panel(page).getByText('Members 57 · exact')).toBeVisible();
    await expect(panel(page).getByText("Counts every USES_GADGET relationship between these two, whatever the view's filters.")).toBeVisible();
    await expect(panel(page).getByText('Sample · first 3 by most recent observed time')).toBeVisible();
    await expect(panel(page).getByText('… 54 more in this sample. There is no paging.')).toBeVisible();
    await expect(panel(page).getByRole('link')).toHaveCount(0);
    await expect(panel(page).getByRole('tab', { name: 'Evidence' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(canvasOf(page)).toBeFocused();
  });
});

const SOURCE = 'banking-demo';

interface Ask {
  readonly sourceId: string;
  readonly ref: { readonly entityType: string; readonly stableId: string };
  readonly neighborTypes: readonly string[];
}

/** An expansion whose page has more rows, so that its aggregate is a lower bound of 3 members; the evidence read then answers with the members it found. */
async function routeAggregate(page: Page, found: number): Promise<void> {
  await page.route((url) => url.pathname === '/v1/graph/expand', async (route) => {
    const body = route.request().postDataJSON() as Ask;
    const type = body.neighborTypes[0] ?? body.ref.entityType;
    const anchor = { sourceId: body.sourceId, ...body.ref };
    const neighbor = { sourceId: body.sourceId, entityType: type, stableId: 'N-1' };
    await route.fulfill({
      json: {
        ref: anchor,
        pageSize: 25,
        nodes: [{ ref: neighbor, display: { title: `${type} N-1`, type }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } }],
        edges: [{ ref: { sourceId: body.sourceId, aggregate: { type: 'SENT', from: anchor, to: neighbor } }, from: anchor, to: neighbor, type: 'SENT', direction: 'from-to', semantics: 'stored', memberCount: { value: 3, quality: 'lowerBound', scope: 'members' }, properties: [], evidenceRefs: [], qualityFlags: [] }],
        pages: body.neighborTypes.map((neighborType) => ({ neighborType, returned: neighborType === type ? 1 : 0, hasMore: true, matchingTotal: { value: 3, quality: 'lowerBound', scope: 'relationships' } })),
        warnings: [],
      },
    });
  });
  await page.route((url) => url.pathname.startsWith('/v1/edges/'), async (route) => {
    const segment = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? '');
    const ref = JSON.parse(Buffer.from(segment.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8')) as { readonly aggregate: { readonly from: { readonly entityType: string; readonly stableId: string }; readonly to: { readonly entityType: string; readonly stableId: string } } };
    const end = (of: { readonly entityType: string; readonly stableId: string }) => ({ ref: { sourceId: SOURCE, ...of }, title: of.stableId, type: of.entityType });
    await route.fulfill({
      json: {
        ref,
        type: 'SENT',
        semantics: 'aggregate',
        from: end(ref.aggregate.from),
        to: end(ref.aggregate.to),
        members: { value: found, quality: 'exact', scope: 'aggregate:members' },
        observedFirst: '2026-01-01T00:00:00Z',
        observedLast: '2026-02-01T00:00:00Z',
        sample: { order: 'observed-newest', rows: Array.from({ length: Math.min(found, 3) }, (_unused, index) => ({ observedAt: `2026-01-0${index + 1}T00:00:00Z`, properties: [] })), more: Math.max(0, found - 3) },
        qualityFlags: [],
        warnings: [],
      },
    });
  });
}

async function openAndExpand(page: Page): Promise<void> {
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: SOURCE }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
  await canvasOf(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await page.keyboard.press('e');
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '2');
}

async function clickBetween(page: Page, from: string, to: string): Promise<void> {
  const a = await screenOf(page, from);
  const b = await screenOf(page, to);
  await page.mouse.click((a.x + b.x) / 2, (a.y + b.y) / 2);
}

const labelOf = async (page: Page): Promise<string | undefined> => (await drawing(page)).edges.find((edge) => edge.label.startsWith('SENT'))?.label;

test.describe('the member count of an aggregate on the canvas and in its evidence panel', () => {
  test('draws a lower bound until the panel has read the members, then draws the exact count the panel states when it is the same number', async ({ page }) => {
    await routeAggregate(page, 3);
    await openAndExpand(page);
    await expect.poll(() => labelOf(page)).toBe('SENT · ≥ 3 · lower bound');
    await clickBetween(page, 'AC-1', 'N-1');
    await expect(panel(page).getByText('Members 3 · exact')).toBeVisible();
    await expect.poll(() => labelOf(page)).toBe('SENT · 3 · exact');
  });

  test('keeps the lower bound when the panel read more members than the expansion drew, since the panel counts every member', async ({ page }) => {
    await routeAggregate(page, 9);
    await openAndExpand(page);
    await clickBetween(page, 'AC-1', 'N-1');
    await expect(panel(page).getByText('Members 9 · exact')).toBeVisible();
    await expect.poll(() => labelOf(page)).toBe('SENT · ≥ 3 · lower bound');
  });

  test('draws no number when the panel read fewer members than the lower bound, so no screen states both', async ({ page }) => {
    await routeAggregate(page, 2);
    await openAndExpand(page);
    await clickBetween(page, 'AC-1', 'N-1');
    await expect(panel(page).getByText('Members 2 · exact')).toBeVisible();
    await expect.poll(() => labelOf(page)).toBe('SENT');
  });
});

