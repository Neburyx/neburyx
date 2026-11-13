import { expect, type Locator, type Page } from '@playwright/test';

const DIRECTION_NAME: Readonly<Record<string, string>> = { out: 'Outgoing', in: 'Incoming', both: 'Either' };

/** The panel of step `n` in the editor `builder`, which is the one shown while its tab is selected. */
export const stepPanel = (builder: Locator, n: number): Locator => builder.getByRole('tabpanel', { name: `Step ${n}` });

/** Adds a step through the editor and chooses its direction, the type it arrives at and its relationship types, by the controls a person uses (the new step is selected). */
export async function buildStepThroughUi(page: Page, builder: Locator, n: number, direction: string, arrivesAt: string, types: readonly string[]): Promise<void> {
  await builder.getByRole('button', { name: '+ Step' }).click();
  const step = stepPanel(builder, n);
  await step.getByRole('radio', { name: DIRECTION_NAME[direction] ?? direction }).click();
  await step.getByLabel('Arrives at').selectOption({ label: arrivesAt });
  await step.getByRole('button', { name: '+ Add type' }).click();
  for (const type of types) await page.getByRole('menuitemcheckbox', { name: new RegExp(`^${type}(?![\\w-])`) }).click();
  await page.keyboard.press('Escape');
}

export const patternsPanel = (page: Page): Locator => page.getByRole('complementary', { name: 'Patterns' });
export const patternsTool = (page: Page): Locator => page.getByRole('button', { name: 'Patterns', exact: true });
export const patternBuilder = (page: Page): Locator => patternsPanel(page).getByRole('region', { name: 'New pattern' });

/** Opens the Patterns panel on its list. */
export async function openPatternList(page: Page): Promise<void> {
  if (!(await patternsPanel(page).isVisible())) await patternsTool(page).click();
  await expect(patternsPanel(page).getByRole('searchbox', { name: 'Search patterns' })).toBeVisible();
}

/** From the list, opens the builder and builds Account → Device ← Account with choices only; the check has answered when it returns. */
export async function buildTwoSteps(page: Page): Promise<void> {
  const builder = patternBuilder(page);
  await patternsPanel(page).getByRole('button', { name: 'New pattern' }).click();
  await builder.getByLabel('Starting entity type').selectOption({ label: 'Account' });
  await buildStepThroughUi(page, builder, 1, 'out', 'Device', ['USES_DEVICE']);
  await buildStepThroughUi(page, builder, 2, 'in', 'Account', ['USES_DEVICE']);
  await expect(builder.getByText('The mapping can follow this pattern')).toBeVisible();
}

/** The draft of `buildTwoSteps`, shown on the preview screen of the run view, with its words read. */
export async function previewTwoSteps(page: Page): Promise<void> {
  await openPatternList(page);
  await buildTwoSteps(page);
  await patternBuilder(page).getByRole('button', { name: 'Preview' }).click();
  await expect(patternsPanel(page).getByRole('heading', { name: 'Preview pattern' })).toBeVisible();
  await expect(patternsPanel(page).getByText('Follows USES_DEVICE outgoing to a device.')).toBeVisible();
}

/** Keyboard-only moves: a control is focused, then the keys do the rest. */
export async function pick(page: Page, select: Locator, label: string): Promise<void> {
  await select.focus();
  await page.keyboard.type(label);
  await expect(select.locator('option:checked')).toHaveText(label);
}

export const press = async (page: Page, control: Locator): Promise<void> => {
  await control.focus();
  await page.keyboard.press('Enter');
};

/** Opens the "⋯" menu of the row named `name` with Enter. */
export async function openRowMenu(page: Page, name: string): Promise<void> {
  await press(page, patternsPanel(page).getByRole('button', { name: `More: ${name}`, exact: true }));
  await expect(page.getByRole('menu', { name })).toBeVisible();
}

/** Chooses the item `item` of the open menu with the arrow keys and Enter. */
export async function chooseMenuItem(page: Page, item: string): Promise<void> {
  const target = page.getByRole('menuitem', { name: item, exact: true });
  await expect(target).toBeVisible();
  for (let presses = 0; presses < 8 && !(await target.evaluate((element) => element === document.activeElement)); presses += 1) await page.keyboard.press('ArrowDown');
  await expect(target).toBeFocused();
  await page.keyboard.press('Enter');
}
