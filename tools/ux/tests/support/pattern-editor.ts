import { type Locator, type Page } from '@playwright/test';

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
