import { expect, test, type Locator, type Page } from '@playwright/test';
import { openOneEntity } from './support/workspace.ts';

const SOURCE = 'banking-demo';

const panelOf = (page: Page) => page.getByRole('complementary', { name: 'Patterns' });
const toolOf = (page: Page) => page.getByRole('button', { name: 'Patterns', exact: true });
const builderOf = (page: Page) => panelOf(page).getByRole('region', { name: 'New pattern' });
const stepOf = (page: Page, n: number) => builderOf(page).getByRole('group', { name: `Step ${n}` });

async function openBuilder(page: Page): Promise<void> {
  await toolOf(page).click();
  await panelOf(page).getByRole('button', { name: 'New pattern' }).click();
  await expect(builderOf(page)).toBeVisible();
}

/** A step built with choices only: its direction, the type it arrives at and its relationship types. */
async function buildStep(page: Page, n: number, direction: string, arrivesAt: string, types: readonly string[]): Promise<void> {
  await builderOf(page).getByRole('button', { name: 'Add step' }).click();
  await stepOf(page, n).getByLabel('Direction').selectOption(direction);
  await stepOf(page, n).getByLabel('Arrives at').selectOption({ label: arrivesAt });
  for (const type of types) await stepOf(page, n).getByRole('checkbox', { name: type }).check();
}

/** Keyboard-only moves: a control is focused, then the keys do the rest. */
async function pick(page: Page, select: Locator, label: string): Promise<void> {
  await select.focus();
  await page.keyboard.type(label);
  await expect(select.locator('option:checked')).toHaveText(label);
}
const press = async (page: Page, control: Locator): Promise<void> => {
  await control.focus();
  await page.keyboard.press('Enter');
};
const space = async (page: Page, control: Locator): Promise<void> => {
  await control.focus();
  await page.keyboard.press('Space');
};
const typeInto = async (page: Page, control: Locator, text: string): Promise<void> => {
  await control.focus();
  await page.keyboard.type(text);
};

test.describe('the pattern builder in the Patterns panel', () => {
  test.beforeEach(async ({ page }) => openOneEntity(page, SOURCE, 'AC-1'));

  test('opens with Enter on New pattern with the focus on Starts at, and Back to patterns gives the focus back', async ({ page }) => {
    await toolOf(page).click();
    await panelOf(page).getByRole('button', { name: 'New pattern' }).focus();
    await page.keyboard.press('Enter');
    await expect(builderOf(page).getByLabel('Starts at')).toBeFocused();
    await builderOf(page).getByRole('button', { name: 'Back to patterns' }).click();
    await expect(panelOf(page).getByRole('button', { name: 'New pattern' })).toBeFocused();
  });

  test('builds a two-step pattern with choices only, and the server says it is valid', async ({ page }) => {
    await openBuilder(page);
    await builderOf(page).getByLabel('Starts at').selectOption({ label: 'Account' });
    await buildStep(page, 1, 'out', 'Device', ['USES_DEVICE']);
    await buildStep(page, 2, 'in', 'Account', ['USES_DEVICE']);
    await expect(builderOf(page).getByRole('group', { name: 'Path' })).toHaveText('Account→USES_DEVICE→Device←USES_DEVICE←Account');
    await expect(builderOf(page).getByText('Valid: the mapping can follow this pattern.')).toBeVisible();
  });

  test('says not valid for the scripted start type, with the problem next to Starts at', async ({ page }) => {
    await openBuilder(page);
    await builderOf(page).getByLabel('Starts at').selectOption({ label: 'Merchant' });
    await builderOf(page).getByRole('button', { name: 'Add step' }).click();
    const options = await stepOf(page, 1).getByLabel('Direction').locator('option').allTextContents();
    expect(options).toContain('Outgoing');
    await stepOf(page, 1).getByLabel('Direction').selectOption('in');
    await stepOf(page, 1).getByLabel('Arrives at').selectOption({ index: 1 });
    await stepOf(page, 1).getByRole('checkbox').first().check();
    await expect(builderOf(page).getByText(/^Not valid\./)).toBeVisible();
    await expect(builderOf(page).getByText('This type is not in the mapping.')).toBeVisible();
  });

  test('holds no control that accepts text: every control is a choice, a checkbox or a button', async ({ page }) => {
    await openBuilder(page);
    await builderOf(page).getByLabel('Starts at').selectOption({ label: 'Account' });
    await buildStep(page, 1, 'out', 'Device', ['USES_DEVICE']);
    const texts = await builderOf(page).locator('input:not([type="checkbox"]), textarea, [contenteditable="true"]').count();
    expect(texts).toBe(0);
  });

  test('opens with Space on New pattern too', async ({ page }) => {
    await toolOf(page).click();
    await panelOf(page).getByRole('button', { name: 'New pattern' }).focus();
    await page.keyboard.press('Space');
    await expect(builderOf(page).getByLabel('Starts at')).toBeFocused();
  });

  test('walks every control in reading order with Tab, and back with Shift+Tab', async ({ page }) => {
    await openBuilder(page);
    await builderOf(page).getByLabel('Starts at').selectOption({ label: 'Account' });
    await buildStep(page, 1, 'out', 'Device', ['USES_DEVICE']);
    const boxes = stepOf(page, 1).getByRole('checkbox');
    const order = [builderOf(page).getByLabel('Starts at'), stepOf(page, 1).getByLabel('Direction'), stepOf(page, 1).getByLabel('Arrives at')];
    for (let index = 0; index < (await boxes.count()); index += 1) order.push(boxes.nth(index));
    order.push(stepOf(page, 1).getByRole('button', { name: 'Add condition' }), stepOf(page, 1).getByRole('combobox', { name: 'Window' }));
    order.push(stepOf(page, 1).getByRole('button', { name: 'Remove step' }), builderOf(page).getByRole('button', { name: 'Add step' }));
    await order[0]?.focus();
    for (const control of order.slice(1)) {
      await page.keyboard.press('Tab');
      await expect(control).toBeFocused();
    }
    for (const control of [...order].reverse().slice(1)) {
      await page.keyboard.press('Shift+Tab');
      await expect(control).toBeFocused();
    }
  });

  test('keeps every control inside the window with four steps, the panel scrolling inside itself', async ({ page }) => {
    await openBuilder(page);
    await builderOf(page).getByLabel('Starts at').selectOption({ label: 'Account' });
    await buildStep(page, 1, 'out', 'Device', ['USES_DEVICE']);
    await buildStep(page, 2, 'in', 'Account', ['USES_DEVICE']);
    await buildStep(page, 3, 'out', 'Device', ['USES_DEVICE']);
    await buildStep(page, 4, 'in', 'Account', ['USES_DEVICE']);
    const size = page.viewportSize();
    const box = await panelOf(page).boundingBox();
    expect(box, 'the panel is drawn').not.toBeNull();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(size?.height ?? 0);
    await builderOf(page).getByRole('button', { name: 'Add step' }).scrollIntoViewIfNeeded();
    await expect(builderOf(page).getByRole('button', { name: 'Add step' })).toBeDisabled();
    await expect(builderOf(page).getByText('This source allows at most 4 steps.')).toBeVisible();
  });
});

/** What the mapping lets a step carry: the properties a condition may be on and a window are chosen from lists; only the values are typed. The packs' own mappings are checked by the packs test of the demo graph tool. */
const PACK = { source: 'banking-demo', entity: 'AC-1', start: 'Account', arrives: 'Device', types: ['USES_DEVICE'], node: ['Device: platform'], relationship: ['Relationship: channel', 'Relationship: lastSeen'], dated: 'lastSeen' } as const;

test.describe('conditions and a window in the builder', () => {
  test.beforeEach(async ({ page }) => openOneEntity(page, PACK.source, PACK.entity));

  test('offers only the filterable properties, and a two-step pattern with an equality, a range and a window, built by keyboard alone, makes a definition the server accepts', async ({ page }) => {
    await openBuilder(page);
    await pick(page, builderOf(page).getByLabel('Starts at'), PACK.start);
    await press(page, builderOf(page).getByRole('button', { name: 'Add step' }));
    await pick(page, stepOf(page, 1).getByLabel('Direction'), 'Outgoing');
    await pick(page, stepOf(page, 1).getByLabel('Arrives at'), PACK.arrives);
    await space(page, stepOf(page, 1).getByRole('checkbox', { name: PACK.types[0] }));
    const step = stepOf(page, 1);
    await press(page, step.getByRole('button', { name: 'Add condition' }));
    expect(await step.getByLabel('Step 1 condition 1: Property').locator('option').allTextContents()).toEqual([...PACK.node, ...PACK.relationship]);
    await typeInto(page, step.getByLabel('Step 1 condition 1: Value'), 'ios');
    await press(page, step.getByRole('button', { name: 'Add condition' }));
    await pick(page, step.getByLabel('Step 1 condition 2: Property'), `Relationship: ${PACK.dated}`);
    await pick(page, step.getByLabel('Step 1 condition 2: Operator'), 'is between');
    await pick(page, step.getByLabel('Step 1 condition 2: Kind of value'), 'Date');
    await typeInto(page, step.getByLabel('Step 1 condition 2: From'), '2026-01-01');
    await pick(page, step.getByRole('combobox', { name: 'Window' }), 'Last N days');
    await typeInto(page, step.getByLabel('Step 1 window: Days'), '30');
    await press(page, builderOf(page).getByRole('button', { name: 'Add step' }));
    await pick(page, stepOf(page, 2).getByLabel('Direction'), 'Incoming');
    await pick(page, stepOf(page, 2).getByLabel('Arrives at'), PACK.start);
    await space(page, stepOf(page, 2).getByRole('checkbox', { name: PACK.types[0] }));
    await expect(builderOf(page).getByText('Valid: the mapping can follow this pattern.')).toBeVisible();
  });

  test('Tab walks a condition row in order and Enter on Remove condition takes it away', async ({ page }) => {
    await openBuilder(page);
    await builderOf(page).getByLabel('Starts at').selectOption({ label: PACK.start });
    await buildStep(page, 1, 'out', PACK.arrives, PACK.types);
    const step = stepOf(page, 1);
    await step.getByRole('button', { name: 'Add condition' }).click();
    const row = step.getByRole('group', { name: 'Step 1 condition 1' });
    const order = ['Property', 'Operator', 'Value', 'Kind of value'].map((label) => row.getByLabel(`Step 1 condition 1: ${label}`));
    await order[0]?.focus();
    for (const control of order.slice(1)) {
      await page.keyboard.press('Tab');
      await expect(control).toBeFocused();
    }
    await page.keyboard.press('Tab');
    await expect(row.getByRole('button', { name: /^Remove condition/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(row).toHaveCount(0);
  });
});
