import { expect, test } from '@playwright/test';
import { canvasOf, drawing } from './support/workspace.ts';

const IDS = ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6', 'AC-7'];
const FILTERS = { entityTypes: [], relTypes: [], time: null, properties: [] };

test.describe('an investigation reopened from its stored draft', () => {
  test('draws every restored entity with its caption, as one that was loaded just now', async ({ page }) => {
    await page.goto('/dev/open-entity');
    await page.getByRole('button', { name: 'banking-demo' }).click();
    const form = page.getByRole('form', { name: 'Open an entity' });
    await form.getByLabel('Stable ID').fill('AC-1');
    await form.getByRole('button', { name: 'Open' }).click();
    await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
    const id = page.url().split('/').pop() ?? '';
    const layout = { schemaVersion: 1, layout: 'force', nodes: IDS.map((stable, index) => ({ t: 'account', id: stable, pinned: false, hidden: false, groupId: null, x: Math.cos(index) * 200, y: Math.sin(index) * 200 })), edges: [], groups: [] };
    const queryContext = { schemaVersion: 1, loaded: { nodes: IDS.map((stable) => ({ t: 'account', id: stable })), edges: [] }, expansions: [], filters: FILTERS };
    const stored = await page.request.put(`/v1/investigations/${id}/draft`, { headers: { 'If-Match': '"1"' }, data: { layout, queryContext, notes: null } });
    expect(stored.status()).toBe(200);

    await page.reload();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', String(IDS.length));
    await expect
      .poll(async () => (await drawing(page)).nodes.map((node) => node.captionShown && node.glyphShown), { message: 'every restored entity shows its caption and its glyph once the canvas has settled' })
      .toEqual(IDS.map(() => true));
  });
});
