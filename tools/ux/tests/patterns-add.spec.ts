import { expect, test, type Page } from '@playwright/test';
import { canvasOf, openOneEntity } from './support/workspace.ts';

const SOURCE = 'banking-demo';
const LIMITS = { slow: '3', cut: '5', stopList: '6' } as const;

const panelOf = (page: Page) => page.getByRole('complementary', { name: 'Patterns' });
const addOf = (page: Page) => panelOf(page).getByRole('button', { name: 'Add to graph' });
const onCanvasOf = (page: Page) => panelOf(page).getByRole('button', { name: 'On canvas' });
const scopeOf = (page: Page) => page.getByText(/entit(y|ies) · \d+ relationships? · loaded/).first();

async function open(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Patterns', exact: true }).click();
  await expect(panelOf(page)).toBeVisible();
}

async function run(page: Page, pattern: string, startLabel: string, limit?: string): Promise<void> {
  await panelOf(page).getByRole('radio', { name: pattern }).click();
  await panelOf(page).getByLabel(startLabel).selectOption({ index: 1 });
  if (limit !== undefined) await panelOf(page).getByLabel('Max matching accounts').fill(limit);
  await panelOf(page).getByRole('button', { name: 'Run pattern' }).click();
}

test.describe('adding a pattern result to the canvas', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post('/__support/patterns-mode', { data: { noPresets: false } });
    await openOneEntity(page, SOURCE, 'AC-1');
    await open(page);
  });

  test('adds the result once, says what was added, counts it everywhere and then reads On canvas', async ({ page }) => {
    await run(page, 'Shared devices', 'Starting account');
    await expect(panelOf(page).getByRole('table')).toBeVisible();
    await addOf(page).click();
    await expect(panelOf(page).getByText('Added 6 entities and 6 relationships. 1 entity already loaded.')).toBeVisible();
    await expect(scopeOf(page)).toContainText('7 entities · 6 relationships · loaded · exact');
    await expect(onCanvasOf(page)).toBeDisabled();
    await expect(addOf(page)).toHaveCount(0);
  });

  test('a repeat of the same run reads On canvas at once and changes nothing', async ({ page }) => {
    await run(page, 'Shared devices', 'Starting account');
    await addOf(page).click();
    await expect(onCanvasOf(page)).toBeDisabled();
    await panelOf(page).getByRole('button', { name: 'Run pattern' }).click();
    await expect(panelOf(page).getByRole('table')).toBeVisible();
    await expect(onCanvasOf(page)).toBeDisabled();
    await expect(scopeOf(page)).toContainText('7 entities · 6 relationships · loaded · exact');
  });

  test('says a cut result is a lower bound and gives no remainder number', async ({ page }) => {
    await run(page, 'Shared devices', 'Starting account', LIMITS.cut);
    await expect(panelOf(page).getByRole('status').filter({ hasText: 'lower bound' }).first()).toHaveText('≥ 5 · lower bound');
    await addOf(page).click();
    const outcome = panelOf(page).getByText(/more matches may exist and were not loaded/);
    await expect(outcome).toContainText('≥ 5 · lower bound');
    await expect(outcome).not.toContainText(/remain|\d+ more/);
  });

  test('keeps the stop-list notice with the result that is added', async ({ page }) => {
    await run(page, 'Shared devices', 'Starting account', LIMITS.stopList);
    await expect(panelOf(page).getByText(/stop list was skipped/)).toBeVisible();
    await addOf(page).click();
    await expect(panelOf(page).getByText(/^Added \d+ entities/)).toBeVisible();
    await expect(panelOf(page).getByText(/stop list was skipped/)).toBeVisible();
  });

  test('adds a linked result: four entities and three relationships, the entity in between included', async ({ page }) => {
    await run(page, 'Connected accounts', 'Starting account');
    await expect(panelOf(page).getByRole('table')).toBeVisible();
    await addOf(page).click();
    await expect(panelOf(page).getByText('Added 3 entities and 3 relationships. 1 entity already loaded.')).toBeVisible();
    await expect(scopeOf(page)).toContainText('4 entities · 3 relationships · loaded');
  });

  test('offers the result that was shown again after a cancelled run, and the add puts that result on the canvas', async ({ page }) => {
    await run(page, 'Shared devices', 'Starting account');
    await expect(panelOf(page).getByRole('table')).toBeVisible();
    await panelOf(page).getByLabel('Max matching accounts').fill(LIMITS.slow);
    await panelOf(page).getByRole('button', { name: 'Run pattern' }).click();
    await expect(panelOf(page).getByText(/^Running/)).toBeVisible();
    await panelOf(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(panelOf(page).getByText('Cancelled. No new matches shown.')).toBeVisible();
    await expect(scopeOf(page)).toContainText('1 entity');
    await addOf(page).click();
    await expect(scopeOf(page)).toContainText('7 entities · 6 relationships · loaded');
  });

  test('the header, the inspector and the Export dialog agree about what is loaded after an add', async ({ page }) => {
    await run(page, 'Shared devices', 'Starting account');
    await addOf(page).click();
    await expect(scopeOf(page)).toContainText('7 entities · 6 relationships · loaded · exact');
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press('Space');
      if (((await inspector.getByRole('heading', { level: 2 }).textContent().catch(() => '')) ?? '').includes('AC-1')) break;
      await page.keyboard.press('Tab');
    }
    await expect(inspector.getByRole('heading', { level: 2 })).toContainText('AC-1');
    await inspector.getByRole('tab', { name: 'Relationships' }).click();
    await expect(inspector.getByRole('tabpanel')).toContainText('1 loaded');
    const remainder = await page.locator('.graph-scope p').nth(1).textContent();
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Export current view' });
    await expect(dialog.getByText(/^coverage: /)).toHaveText(`coverage: ${remainder}`);
    await expect(dialog).toContainText('7');
    await page.keyboard.press('Escape');
  });
});

test.describe('adding a result on the insurance pack', () => {
  test.use({ baseURL: 'http://127.0.0.1:4175' });

  test('adds four entities and three relationships from the first claimant, then reads On canvas', async ({ page }) => {
    await page.goto('/dev/open-entity');
    await page.getByRole('button', { name: 'claims-demo', exact: true }).click();
    const form = page.getByRole('form', { name: 'Open an entity' });
    await form.getByLabel('Entity type').selectOption('claimant');
    await form.getByLabel('Stable ID').fill('CL-1');
    await form.getByRole('button', { name: 'Open' }).click();
    await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
    await open(page);
    await run(page, 'Shared addresses', 'Starting claimant');
    await expect(addOf(page)).toBeVisible();
    await addOf(page).click();
    await expect(panelOf(page).getByText('Added 3 entities and 3 relationships. 1 entity already loaded.')).toBeVisible();
    await expect(onCanvasOf(page)).toBeDisabled();
    await expect(page.getByText(/4 entities · 3 relationships · loaded · exact/)).toBeVisible();
    await panelOf(page).getByRole('button', { name: 'Run pattern' }).click();
    await expect(onCanvasOf(page)).toBeDisabled();
    await expect(addOf(page)).toHaveCount(0);
  });
});
