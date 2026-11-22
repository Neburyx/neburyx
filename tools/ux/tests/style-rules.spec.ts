import { expect, test, type Page } from '@playwright/test';
import { apartFromInspector, canvasOf, openSample } from './support/workspace.ts';

const legend = (page: Page) => page.locator('.legend-panel');

async function openLegend(page: Page): Promise<void> {
  await canvasOf(page).focus();
  await page.keyboard.press('l');
  await expect(page.getByRole('button', { name: 'Close Legend' })).toBeVisible();
}

test.describe('style rules', () => {
  test('list in the legend under STYLE RULES with the condition and the type, then the footnote and a link in the tab order, and the entity types are still there', async ({ page }) => {
    await openSample(page, '?rules=on');
    await openLegend(page);
    await expect(legend(page).getByRole('heading', { name: 'STYLE RULES from neburyx.yaml' })).toBeVisible();
    const rows = legend(page).locator('.legend-rule');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0).locator('.legend-rule-title')).toHaveText('Amber badge: review required');
    await expect(rows.nth(0).locator('.legend-rule-detail').first()).toHaveText('status = Review required · Ledger');
    await expect(rows.nth(1).locator('.legend-rule-title')).toHaveText('Larger node: live ledger');
    await expect(rows.nth(1).locator('.legend-rule-detail')).toHaveCount(1);
    await expect(legend(page).getByText('Rules run after your access policy. A rule on a masked property never changes how an item looks.')).toBeVisible();
    const link = legend(page).getByRole('link', { name: 'Edit rules in neburyx.yaml' });
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await link.focus();
    await expect(link).toBeFocused();
    await expect(legend(page).locator('.legend-type')).not.toHaveCount(0);
  });

  test('show no section and no change to the legend when the mapping has no rules', async ({ page }) => {
    await openSample(page);
    await openLegend(page);
    await expect(legend(page).getByRole('heading', { name: /STYLE RULES/ })).toHaveCount(0);
    await expect(legend(page).locator('.legend-relationship')).toHaveCount(4);
  });

  test('draw the whole sample with its rules and fetch nothing: opening the legend and reading the rules sends no request', async ({ page }) => {
    await openSample(page, '?rules=on');
    const requests: string[] = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith('/v1/')) requests.push(`${request.method()} ${pathname}`);
    });
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '10');
    await openLegend(page);
    expect(apartFromInspector(requests)).toEqual([]);
  });
});
