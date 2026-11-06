import { expect, test, type Locator, type Page } from '@playwright/test';
import { addPlainControls, lookOf, tokenColour, tokenLength, withoutDefaultRules } from './support/controls.ts';
import { openSample, tabTo } from './support/workspace.ts';

const plain = (page: Page, name: string): Locator => page.locator('#plain-controls').getByRole('button', { name, exact: true });

async function snapshot(controls: readonly Locator[]): Promise<Array<Record<string, string>>> {
  const looks: Array<Record<string, string>> = [];
  for (const control of controls) looks.push(await lookOf(control));
  return looks;
}

async function allOf(locator: Locator): Promise<Locator[]> {
  const found: Locator[] = [];
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) found.push(locator.nth(index));
  return found;
}

test.describe('the shared look of buttons, selectors and fields', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/sources');
    await expect(page.getByRole('button', { name: 'Test source' })).toBeVisible();
    await addPlainControls(page);
  });

  test('draws a plain button, selector and field from the tokens and not the browser', async ({ page }) => {
    const border = await tokenColour(page, '--color-control-border');
    const surface = await tokenColour(page, '--color-surface');
    const text = await tokenColour(page, '--color-text');
    const height = await tokenLength(page, '--button-height');
    const controls = [plain(page, 'Plain button'), plain(page, 'Empty class'), page.getByRole('combobox', { name: 'Plain selector' }), page.getByRole('textbox', { name: 'Plain field' }), page.getByRole('searchbox', { name: 'Plain search' })];
    for (const control of controls) {
      const look = await lookOf(control);
      expect(look['border-top-width']).toBe('1px');
      expect(look['border-top-style']).toBe('solid');
      expect(look['border-top-color']).toBe(border);
      expect(look['border-top-left-radius']).toBe('6px');
      expect(look['background-color']).toBe(surface);
      expect(look['color']).toBe(text);
      expect(look['font-size']).toBe('12px');
      expect(look['height']).toBe(height);
    }
  });

  test('does not change a classed control, a disabled one, a busy region or a source list item', async ({ page }) => {
    await page.evaluate(() => {
      const holder = document.createElement('div');
      holder.id = 'classed-controls';
      holder.innerHTML = `
        <button type="button" class="zoom-button" disabled>Zoom</button>
        <button type="button" class="menu-row" aria-disabled="true">Row</button>
        <button type="button" class="tool-button">Tool</button>
        <button type="button" class="selection-action" aria-busy="true">Action</button>
        <div class="search-results" aria-busy="true">Results</div>`;
      document.querySelector('main')?.prepend(holder);
    });
    const controls = [...(await allOf(page.locator('#classed-controls').locator('button, div'))), ...(await allOf(page.locator('.source-list button')))];
    expect(controls.length).toBeGreaterThanOrEqual(6);
    for (const state of ['idle', 'hovered'] as const) {
      for (const control of controls) {
        if (state === 'hovered') await control.hover({ force: true });
        else await page.mouse.move(0, 0);
        const withDefaults = await lookOf(control);
        const withoutDefaults = await withoutDefaultRules(page, () => lookOf(control));
        expect(withDefaults, `${state}: ${await control.textContent()}`).toEqual(withoutDefaults);
      }
    }
  });

  test('keeps the Test source and Diagnostics bundle buttons as they were', async ({ page }) => {
    const accent = await tokenColour(page, '--color-accent');
    const surface = await tokenColour(page, '--color-surface');
    const muted = await tokenColour(page, '--color-text-muted');
    const mutedFill = await tokenColour(page, '--color-surface-muted');
    const workspaceBorder = await tokenColour(page, '--color-workspace-border');
    const test = await lookOf(page.getByRole('button', { name: 'Test source' }));
    expect(test).toMatchObject({ 'background-color': accent, 'border-top-color': accent, color: surface, height: '34px', 'padding-left': '12px', 'border-top-left-radius': '6px', 'font-size': '12px', cursor: 'pointer' });
    const diagnostics = await lookOf(page.getByRole('button', { name: 'Diagnostics bundle' }));
    expect(diagnostics).toMatchObject({ 'background-color': mutedFill, 'border-top-color': workspaceBorder, color: muted, height: '34px', 'padding-left': '12px', 'border-top-left-radius': '6px', 'font-size': '12px' });
  });

  test('draws a link-style button as accent text with no border and no fill, underlined on hover, and still a button', async ({ page }) => {
    const accent = await tokenColour(page, '--color-accent');
    const link = plain(page, 'Link');
    const look = await lookOf(link);
    expect(look).toMatchObject({ 'border-top-width': '0px', 'background-color': 'rgba(0, 0, 0, 0)', color: accent, 'text-decoration-line': 'none' });
    await link.hover();
    expect((await lookOf(link))['text-decoration-line']).toBe('underline');
  });

  test('changes the fill of a live control on hover and leaves a disabled one alone', async ({ page }) => {
    const muted = await tokenColour(page, '--color-surface-muted');
    const hover = await tokenColour(page, '--color-accent-hover');
    const surface = await tokenColour(page, '--color-surface');
    const accent = await tokenColour(page, '--color-accent');
    for (const [name, before, after] of [['Plain button', surface, muted], ['Secondary', surface, muted], ['Primary', accent, hover]] as const) {
      const control = plain(page, name);
      expect((await lookOf(control))['background-color'], `${name} idle`).toBe(before);
      await control.hover();
      expect((await lookOf(control))['background-color'], `${name} hovered`).toBe(after);
    }
    for (const name of ['Disabled', 'Aria disabled', 'Disabled primary', 'Busy primary']) {
      const control = plain(page, name);
      const idle = (await lookOf(control))['background-color'];
      await control.hover({ force: true });
      expect((await lookOf(control))['background-color'], `${name} hovered`).toBe(idle);
    }
  });

  test('draws the focus outline of the token on each control a keyboard reaches', async ({ page }) => {
    const focus = await tokenColour(page, '--color-focus');
    const controls = [plain(page, 'Plain button'), plain(page, 'Primary'), plain(page, 'Secondary'), plain(page, 'Link'), page.getByRole('combobox', { name: 'Plain selector' }), page.getByRole('textbox', { name: 'Plain field' }), page.getByRole('searchbox', { name: 'Plain search' })];
    for (const control of controls) {
      await tabTo(page, control);
      expect(await lookOf(control, ['outline-style', 'outline-width', 'outline-color']), await control.textContent() ?? '').toEqual({ 'outline-style': 'solid', 'outline-width': '3px', 'outline-color': focus });
    }
  });

  test('draws a disabled control muted with the default cursor, and a busy button at full strength with the progress cursor', async ({ page }) => {
    const mutedFill = await tokenColour(page, '--color-surface-muted');
    const muted = await tokenColour(page, '--color-text-muted');
    const workspaceBorder = await tokenColour(page, '--color-workspace-border');
    const accent = await tokenColour(page, '--color-accent');
    for (const name of ['Disabled', 'Aria disabled', 'Disabled primary']) expect(await lookOf(plain(page, name)), name).toMatchObject({ 'background-color': mutedFill, color: muted, 'border-top-color': workspaceBorder, cursor: 'default' });
    expect(await lookOf(plain(page, 'Disabled link'))).toMatchObject({ color: muted, 'text-decoration-line': 'none', cursor: 'default' });
    expect(await lookOf(plain(page, 'Busy primary'))).toMatchObject({ 'background-color': accent, opacity: '1', cursor: 'progress' });
  });

  test('draws a selector with the product chevron and operates it from the keyboard', async ({ page }) => {
    const selector = page.getByRole('combobox', { name: 'Plain selector' });
    const look = await lookOf(selector);
    expect(look['appearance']).toBe('none');
    expect(look['background-image']).toContain('url(');
    await tabTo(page, selector);
    await page.keyboard.type('t');
    await expect(selector).toHaveValue('two');
  });

  test('does not change the controls of the Search panel on the canvas, tabs, Add buttons and close included, idle and hovered', async ({ page }) => {
    await page.goto(`/banking-demo/entity/account/CTL-${String(Date.now()).slice(-6)}`);
    await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('tab', { name: /Add from source/ }).click();
    await page.getByRole('searchbox', { name: 'Find in the source' }).fill('AC-2');
    await expect(page.getByRole('button', { name: /^Add / }).first()).toBeVisible();
    const controls = await allOf(page.locator('.search-panel').locator('button:visible, input:visible'));
    expect(controls.length).toBeGreaterThanOrEqual(5);
    for (const state of ['idle', 'hovered'] as const) {
      for (const control of controls) {
        if (state === 'hovered') await control.hover({ force: true });
        else await page.mouse.move(0, 0);
        const withDefaults = await lookOf(control);
        const withoutDefaults = await withoutDefaultRules(page, () => lookOf(control));
        expect(withDefaults, `${state}: ${await control.getAttribute('class') ?? 'plain'}`).toEqual(withoutDefaults);
      }
    }
  });

  test('draws a plain control on the workspace page too', async ({ page }) => {
    await openSample(page);
    await addPlainControls(page);
    const control = plain(page, 'Plain button');
    await expect(control).toBeVisible();
    expect((await lookOf(control))['border-top-left-radius']).toBe('6px');
  });
});
