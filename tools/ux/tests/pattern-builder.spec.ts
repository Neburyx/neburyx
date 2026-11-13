import { expect, test, type Locator, type Page } from '@playwright/test';
import { openOneEntity } from './support/workspace.ts';
import { buildStepThroughUi, stepPanel } from './support/pattern-editor.ts';

const SOURCE = 'banking-demo';

const panelOf = (page: Page) => page.getByRole('complementary', { name: 'Patterns' });
const toolOf = (page: Page) => page.getByRole('button', { name: 'Patterns', exact: true });
const builderOf = (page: Page) => panelOf(page).getByRole('region', { name: 'New pattern' });
const stepOf = (page: Page, n: number) => stepPanel(builderOf(page), n);

async function openBuilder(page: Page): Promise<void> {
  await toolOf(page).click();
  await panelOf(page).getByRole('button', { name: 'New pattern' }).click();
  await expect(builderOf(page)).toBeVisible();
}

/** A step built with choices only: its direction, the type it arrives at and its relationship types. */
const buildStep = (page: Page, n: number, direction: string, arrivesAt: string, types: readonly string[]): Promise<void> => buildStepThroughUi(page, builderOf(page), n, direction, arrivesAt, types);

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

  test('opens with Enter on New pattern with the focus on Starts at, and Cancel gives the focus back', async ({ page }) => {
    await toolOf(page).click();
    await panelOf(page).getByRole('button', { name: 'New pattern' }).focus();
    await page.keyboard.press('Enter');
    await expect(builderOf(page).getByLabel('Starting entity type')).toBeFocused();
    await builderOf(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(panelOf(page).getByRole('button', { name: 'New pattern' })).toBeFocused();
  });

  test('builds a two-step pattern with choices only, and the server says it is valid', async ({ page }) => {
    await openBuilder(page);
    await builderOf(page).getByLabel('Starting entity type').selectOption({ label: 'Account' });
    await buildStep(page, 1, 'out', 'Device', ['USES_DEVICE']);
    await buildStep(page, 2, 'in', 'Account', ['USES_DEVICE']);
    await expect(builderOf(page).getByRole('group', { name: 'Path' })).toHaveText('Account→USES_DEVICE→Device←USES_DEVICE←Account');
    await expect(builderOf(page).getByText('The mapping can follow this pattern')).toBeVisible();
  });

  test('lists the problem of the scripted start type with Show, which opens the Start tab and focuses its type', async ({ page }) => {
    await openBuilder(page);
    await builderOf(page).getByLabel('Starting entity type').selectOption({ label: 'Merchant' });
    await builderOf(page).getByRole('button', { name: '+ Step' }).click();
    await expect(stepOf(page, 1).getByRole('radio', { name: 'Outgoing' })).toBeVisible();
    await stepOf(page, 1).getByRole('radio', { name: 'Incoming' }).click();
    await stepOf(page, 1).getByLabel('Arrives at').selectOption({ index: 1 });
    await stepOf(page, 1).getByRole('button', { name: '+ Add type' }).click();
    await page.getByRole('menuitemcheckbox').first().click();
    await page.keyboard.press('Escape');
    await expect(builderOf(page).getByText('1 problem from the source. Preview is off.')).toBeVisible();
    await expect(builderOf(page).getByRole('group', { name: 'The mapping cannot follow this pattern yet' })).toContainText('Start: This type is not in the mapping.');
    await builderOf(page).getByRole('button', { name: 'Show problem 1' }).click();
    await expect(builderOf(page).getByLabel('Starting entity type')).toBeFocused();
    await expect(builderOf(page).getByText('This type is not in the mapping.').first()).toBeVisible();
  });

  test('holds no control that accepts text: every control is a choice, a checkbox or a button', async ({ page }) => {
    await openBuilder(page);
    await builderOf(page).getByLabel('Starting entity type').selectOption({ label: 'Account' });
    await buildStep(page, 1, 'out', 'Device', ['USES_DEVICE']);
    // the search of Starts from only searches; no typed text becomes an identifier
    await expect(builderOf(page).locator('input[type="search"]')).toHaveCount(1);
    await expect(builderOf(page).getByRole('searchbox', { name: 'Search the source' })).toHaveCount(1);
    expect(await builderOf(page).locator('input:not([type="checkbox"]):not([type="search"]), textarea, [contenteditable="true"]').count()).toBe(0);
  });

  test('opens with Space on New pattern too', async ({ page }) => {
    await toolOf(page).click();
    await panelOf(page).getByRole('button', { name: 'New pattern' }).focus();
    await page.keyboard.press('Space');
    await expect(builderOf(page).getByLabel('Starting entity type')).toBeFocused();
  });

  test('walks the stops of the editor in the frame’s order with Tab: the panel’s Close, the step tabs as one stop, + Step, Remove step, the parts as one stop, the direction, Add type, Arrives at, then Cancel and Preview', async ({ page }) => {
    await openBuilder(page);
    await builderOf(page).getByLabel('Starting entity type').selectOption({ label: 'Account' });
    await buildStep(page, 1, 'out', 'Device', ['USES_DEVICE']);
    await expect(builderOf(page).getByText('The mapping can follow this pattern')).toBeVisible();
    await panelOf(page).getByRole('button', { name: 'Close pattern builder' }).focus();
    const names: string[] = [];
    for (let count = 0; count < 40; count += 1) {
      names.push(await page.evaluate(() => (document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '').trim()));
      if (names[names.length - 1] === 'Preview') break;
      await page.keyboard.press('Tab');
    }
    const order = ['Close pattern builder', 'Step 1', '+ Step', 'Remove step 1', 'Link', 'Outgoing', 'Incoming', 'Either', 'Remove USES_DEVICE', '+ Add type', 'Cancel', 'Preview'];
    const at = order.map((name) => names.indexOf(name));
    expect(at.every((place) => place >= 0), names.join(' | ')).toBe(true);
    expect([...at].sort((left, right) => left - right)).toEqual(at);
    // one stop for the step tabs and one for the parts: no other tab of either row is visited
    expect(names).not.toContain('Start');
    expect(names).not.toContain('Window · none');
  });

  test('keeps every control inside the window with four steps, the panel scrolling inside itself', async ({ page }) => {
    await openBuilder(page);
    await builderOf(page).getByLabel('Starting entity type').selectOption({ label: 'Account' });
    await buildStep(page, 1, 'out', 'Device', ['USES_DEVICE']);
    await buildStep(page, 2, 'in', 'Account', ['USES_DEVICE']);
    await buildStep(page, 3, 'out', 'Device', ['USES_DEVICE']);
    await buildStep(page, 4, 'in', 'Account', ['USES_DEVICE']);
    const size = page.viewportSize();
    const box = await panelOf(page).boundingBox();
    expect(box, 'the panel is drawn').not.toBeNull();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(size?.height ?? 0);
    await builderOf(page).getByRole('button', { name: '+ Step' }).scrollIntoViewIfNeeded();
    await expect(builderOf(page).getByRole('button', { name: '+ Step' })).toBeDisabled();
    await expect(builderOf(page).getByText('This source allows at most 4 steps.')).toBeVisible();
  });
});

/** What the mapping lets a step carry: the properties a condition may be on and a window are chosen from lists; only the values are typed. The packs' own mappings are checked by the packs test of the demo graph tool. */
const PACK = { source: 'banking-demo', entity: 'AC-1', start: 'Account', arrives: 'Device', types: ['USES_DEVICE'], node: ['Device: platform'], relationship: ['Relationship: channel', 'Relationship: lastSeen'], dated: 'lastSeen' } as const;

test.describe('conditions and a window in the builder', () => {
  test.beforeEach(async ({ page }) => openOneEntity(page, PACK.source, PACK.entity));

  test('builds a two-step pattern with an equality, a range and a window by keyboard alone, and the source says it is valid', async ({ page }) => {
    await openBuilder(page);
    await pick(page, builderOf(page).getByLabel('Starting entity type'), PACK.start);
    await press(page, builderOf(page).getByRole('button', { name: '+ Step' }));
    await press(page, stepOf(page, 1).getByRole('radio', { name: 'Outgoing' }));
    await pick(page, stepOf(page, 1).getByLabel('Arrives at'), PACK.arrives);
    await press(page, stepOf(page, 1).getByRole('button', { name: '+ Add type' }));
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    const step = stepOf(page, 1);
    await step.getByRole('tab', { name: 'Link' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(step.getByRole('tab', { name: /^Conditions/ })).toHaveAttribute('aria-selected', 'true');
    // the menu offers only what the mapping lets a condition use, node properties first
    await press(page, step.getByRole('button', { name: '+ Add condition' }));
    expect(await page.getByRole('menuitem').locator('.popup-menu-type').allTextContents()).toEqual(['platform', 'channel', 'lastSeen']);
    await page.keyboard.press('Enter');
    await typeInto(page, step.getByLabel('Step 1 condition 1: Value'), 'ios');
    await press(page, step.getByRole('group', { name: 'Step 1 condition 1' }).getByRole('button', { name: 'Done' }));
    await press(page, step.getByRole('button', { name: '+ Add condition' }));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await pick(page, step.getByLabel('Step 1 condition 2: Operator'), 'is between');
    await pick(page, step.getByLabel('Step 1 condition 2: Kind of value'), 'Date');
    await typeInto(page, step.getByLabel('Step 1 condition 2: From'), '2026-01-01');
    await press(page, step.getByRole('group', { name: 'Step 1 condition 2' }).getByRole('button', { name: 'Done' }));
    await step.getByRole('tab', { name: /^Conditions/ }).focus();
    await page.keyboard.press('ArrowRight');
    await press(page, step.getByRole('radio', { name: 'Last N days' }));
    await typeInto(page, step.getByLabel('Step 1 window: Days'), '30');
    await press(page, builderOf(page).getByRole('button', { name: '+ Step' }));
    await press(page, stepOf(page, 2).getByRole('radio', { name: 'Incoming' }));
    await pick(page, stepOf(page, 2).getByLabel('Arrives at'), PACK.start);
    await press(page, stepOf(page, 2).getByRole('button', { name: '+ Add type' }));
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    await expect(builderOf(page).getByText('The mapping can follow this pattern')).toBeVisible();
    await expect(builderOf(page).getByRole('button', { name: 'Preview' })).toBeEnabled();
  });

  test('Tab walks the form of a condition in order, Done closes it, and Enter on Remove condition takes the row away', async ({ page }) => {
    await openBuilder(page);
    await builderOf(page).getByLabel('Starting entity type').selectOption({ label: PACK.start });
    await buildStep(page, 1, 'out', PACK.arrives, PACK.types);
    const step = stepOf(page, 1);
    await step.getByRole('tab', { name: /^Conditions/ }).click();
    await step.getByRole('button', { name: '+ Add condition' }).click();
    await page.keyboard.press('Enter');
    const row = step.getByRole('group', { name: 'Step 1 condition 1' });
    const field = (label: string) => row.getByLabel(`Step 1 condition 1: ${label}`);
    await expect(field('Property')).toBeFocused();
    for (const label of ['Operator', 'Kind of value', 'Value']) {
      await page.keyboard.press('Tab');
      await expect(field(label)).toBeFocused();
    }
    await typeInto(page, field('Value'), 'ios');
    await page.keyboard.press('Tab');
    await expect(row.getByRole('button', { name: 'Done' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(row.getByText('platform is ios')).toBeVisible();
    await row.getByRole('button', { name: /^Edit condition: / }).focus();
    await page.keyboard.press('Tab');
    await expect(row.getByRole('button', { name: /^Remove condition: / })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(row).toHaveCount(0);
  });

  test('a change to the start leaves the later steps and marks them, and Undo change puts the pattern back', async ({ page }) => {
    await openBuilder(page);
    await builderOf(page).getByLabel('Starting entity type').selectOption({ label: 'Account' });
    await buildStep(page, 1, 'out', 'Device', ['USES_DEVICE']);
    await buildStep(page, 2, 'in', 'Account', ['USES_DEVICE']);
    const before = await builderOf(page).getByRole('group', { name: 'Path' }).textContent();
    await builderOf(page).getByRole('tab', { name: 'Start' }).click();
    await builderOf(page).getByLabel('Starting entity type').selectOption({ label: 'Device' });
    const banner = builderOf(page).getByRole('group', { name: 'Changes that break the pattern' });
    await expect(banner).toContainText('Changing the start leaves');
    await expect(banner).toContainText('Nothing is removed for you.');
    await expect(builderOf(page).getByRole('tab', { name: /^Step 1 !$/ })).toBeVisible();
    await expect(builderOf(page).getByRole('tab', { name: /^Step 2/ })).toBeVisible();
    await expect(builderOf(page).getByRole('button', { name: 'Preview' })).toBeDisabled();
    await banner.getByRole('button', { name: 'Undo change' }).click();
    await expect(banner).toHaveCount(0);
    await expect(builderOf(page).getByLabel('Starting entity type')).toHaveValue(/account/i);
    await expect(builderOf(page).getByRole('group', { name: 'Path' })).toHaveText(before ?? '');
  });
});
