import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openOneEntity } from './support/workspace.ts';
import { chooseMenuItem, openPatternList, openRowMenu, patternsPanel as panelOf, press, stepPanel } from './support/pattern-editor.ts';

const SOURCE = 'banking-demo';
const NAME = 'Fan, order and cycle';
const rowOf = (page: Page, name: string) => panelOf(page).getByRole('listitem').filter({ has: page.getByRole('heading', { name, level: 4, exact: true }) });

/** Full-size PNGs for review, kept outside the repository: only when the run is told where. */
async function shot(page: Page, name: string): Promise<void> {
  const folder = process.env['NEBURYX_UX_SHOTS'];
  if (folder === undefined || folder === '') return;
  mkdirSync(folder, { recursive: true });
  await page.screenshot({ path: join(folder, `${name}.png`), fullPage: false });
}

test.describe('the three kinds of the extension in the Patterns panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post('/__support/reset');
    await openOneEntity(page, SOURCE, 'AC-1');
    const out = { relationshipTypes: ['USES_DEVICE'], direction: 'out', arrivesAt: 'device', fan: { atLeast: 3 } };
    const back = { relationshipTypes: ['USES_DEVICE'], direction: 'in', arrivesAt: 'account', after: 'previous', closesAtAnchor: true };
    const saved = await page.request.post('/v1/patterns', {
      headers: { 'content-type': 'application/json' },
      data: { sourceId: SOURCE, kind: 'definition', name: NAME, definition: { anchorType: 'account', steps: [out, back] } },
    });
    expect(saved.status()).toBe(201);
    await openPatternList(page);
  });

  test('shows a saved definition with a fan, a time order and a closing in its row, and in words on the preview', async ({ page }) => {
    const row = rowOf(page, NAME);
    await expect(row).toContainText('(at least 3 neighbours)');
    await expect(row).toContainText('after previous');
    await expect(row).toContainText('closes back');
    await shot(page, 'patterns-list-extension');
    await press(page, row.getByRole('button', { name: `Run ${NAME}` }));
    await expect(panelOf(page).getByRole('heading', { name: 'Preview pattern' })).toBeVisible();
    const words = panelOf(page).getByRole('region', { name: 'In plain words' });
    await expect(words).toContainText('Step 1: follow USES_DEVICE forward to at least 3 other devices');
    await expect(words).toContainText('Step 2: follow USES_DEVICE backward and close back at the start account, after the previous step (by lastSeen)');
    await shot(page, 'patterns-preview-extension');
    await expect(page.locator('body')).not.toHaveJSProperty('scrollWidth', 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test('opens the definition in the builder with the three kinds shown, keeps them through a save, and keeps and marks a closing that an added step breaks, with Undo', async ({ page }) => {
    await openRowMenu(page, NAME);
    await chooseMenuItem(page, 'Change');
    const builder = panelOf(page);
    await expect(builder.getByRole('heading', { name: `Change pattern: ${NAME}` })).toBeVisible();
    const chain = builder.locator('.pattern-chain');
    await expect(chain).toContainText('at least 3 neighbours');
    await expect(chain).toContainText('after previous');
    await expect(chain).toContainText('closes back');
    await expect(builder.getByRole('region', { name: 'In words' })).toContainText('at least 3 other devices');
    await builder.getByRole('tab', { name: /^Step 1( !)?$/ }).click();
    await expect(builder.getByRole('region', { name: 'Step 1 extended' })).toContainText('Shown here, not editable yet');
    await shot(page, 'patterns-builder-extension');
    await builder.getByRole('tab', { name: /^Step 1( !)?$/ }).click();
    const first = stepPanel(builder, 1);
    await first.getByRole('tab', { name: /^Conditions/ }).click();
    await first.getByRole('button', { name: '+ Add condition' }).click();
    await page.keyboard.press('Enter');
    await first.getByLabel('Step 1 condition 1: Value').fill('ios');
    await first.getByRole('group', { name: 'Step 1 condition 1' }).getByRole('button', { name: 'Done' }).click();
    await expect(chain).toContainText('1 of 24 conditions');
    await expect(builder.getByText('The mapping can follow this pattern')).toBeVisible();
    await expect(builder.getByRole('button', { name: 'Preview' })).toBeEnabled();
    await press(page, builder.getByRole('button', { name: 'Preview' }));
    await expect(builder.getByRole('heading', { name: 'Preview pattern' })).toBeVisible();
    await expect(builder.getByRole('region', { name: 'In plain words' })).toContainText('close back at the start');
    await press(page, builder.getByRole('button', { name: 'Save changes…' }));
    const dialog = page.getByRole('dialog');
    if (await dialog.count() > 0) await press(page, dialog.getByRole('button', { name: /^Save( changes)?$/ }));
    await expect(builder.getByText(/Pattern (saved|changed)\./)).toBeVisible();
    await expect(rowOf(page, NAME)).toContainText('(at least 3 neighbours)');
    await expect(rowOf(page, NAME)).toContainText('after previous');
    await expect(rowOf(page, NAME)).toContainText('closes back');
    await openRowMenu(page, NAME);
    await chooseMenuItem(page, 'Change');
    await expect(chain).toContainText('1 of 24 conditions');
    await expect(chain).toContainText('at least 3 neighbours');
    await expect(chain).toContainText('after previous');
    await expect(chain).toContainText('closes back');
    await press(page, builder.getByRole('button', { name: 'Cancel' }));
    const discard = page.getByRole('dialog');
    if (await discard.count() > 0) await press(page, discard.getByRole('button', { name: 'Discard draft' }));
    await openRowMenu(page, NAME);
    await chooseMenuItem(page, 'Change');
    await press(page, builder.getByRole('button', { name: '+ Step' }));
    const banner = builder.getByRole('group', { name: 'Changes that break the pattern' });
    await expect(banner).toContainText('it closes the cycle at the start, and it is no longer the last step');
    await expect(builder.getByRole('region', { name: 'In words' })).toContainText('Kept, not valid');
    await expect(builder.getByRole('button', { name: 'Preview' })).toBeDisabled();
    await expect(chain).toContainText('closes back');
    await shot(page, 'patterns-builder-extension-broken');
    await press(page, banner.getByRole('button', { name: 'Undo change' }));
    await expect(banner).toHaveCount(0);
    await expect(builder.getByRole('button', { name: 'Preview' })).toBeEnabled();
  });

  test('keeps and marks a step ordered after the previous one when the mapping gives its relationship no time', async ({ page }) => {
    const hop = (extra: Record<string, unknown> = {}) => ({ relationshipTypes: ['TRANSFERRED_TO'], direction: 'out', arrivesAt: 'account', ...extra });
    const saved = await page.request.post('/v1/patterns', { headers: { 'content-type': 'application/json' }, data: { sourceId: SOURCE, kind: 'definition', name: 'Needs a time', definition: { anchorType: 'account', steps: [hop(), hop({ after: 'previous' })] } } });
    expect(saved.status()).toBe(201);
    await page.reload();
    await openPatternList(page);
    await openRowMenu(page, 'Needs a time');
    await chooseMenuItem(page, 'Change');
    const builder = panelOf(page);
    const banner = builder.getByRole('group', { name: 'Changes that break the pattern' });
    await expect(banner).toContainText('“after the previous step” needs a time in the mapping. TRANSFERRED_TO has none.');
    await expect(builder.getByRole('region', { name: 'In words' })).toContainText('Kept, not valid');
    await builder.getByRole('tab', { name: /^Step 2( !)?$/ }).click();
    await expect(builder.getByRole('region', { name: 'Step 2 extended' })).toContainText('Not valid');
    await expect(builder.getByRole('region', { name: 'Step 2 extended' })).toContainText('no time in the mapping');
    await expect(builder.getByRole('button', { name: 'Preview' })).toBeDisabled();
    await shot(page, 'patterns-builder-no-time');
  });
});
