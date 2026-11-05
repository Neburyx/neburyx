import { expect, test, type Page } from '@playwright/test';
import { announcement, canvasOf, focusCanvas, lastPrevented, modifier, openSample, positions, recordPrevented } from './support/workspace.ts';

const description = (page: Page): Promise<string> => canvasOf(page).evaluate((element) => document.getElementById(element.getAttribute('aria-describedby') ?? '')?.textContent ?? '');
const legendOpen = async (page: Page): Promise<boolean> => (await page.getByRole('button', { name: 'Close Legend' }).count()) > 0;
const zoomOf = (page: Page): Promise<number> => canvasOf(page).evaluate((element) => Number(element.dataset['zoom']));

/** The tool the strip has chosen, read from the Explore flyout's checked row, and the flyout closed again. */
async function currentTool(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Explore' }).focus();
  await page.keyboard.press('Enter');
  const checked = await page.getByRole('menuitemradio', { checked: true }).first().getAttribute('aria-label').catch(() => null);
  const name = checked ?? (await page.getByRole('menuitemradio', { checked: true }).first().locator('.menu-label').textContent());
  await page.keyboard.press('Escape');
  return (name ?? '').trim();
}

async function walkTo(page: Page, announced: RegExp): Promise<void> {
  for (let step = 0; step < 40; step += 1) {
    if (announced.test((await announcement(page).textContent()) ?? '')) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('WALK_NEVER_REACHED');
}

test.describe('typing in a text field', () => {
  test('triggers no key: the tool, the legend, the zoom, the sheet and the selection stay as they are', async ({ page }) => {
    await openSample(page);
    const mod = await modifier(page);
    await focusCanvas(page);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    const before = { tool: await currentTool(page), zoom: await zoomOf(page), selection: await description(page) };
    await page.evaluate(() => {
      const field = document.createElement('input');
      field.id = 'probe-field';
      field.setAttribute('aria-label', 'Probe field');
      document.querySelector('.workspace')?.append(field);
    });
    await page.locator('#probe-field').focus();
    for (const key of ['h', 'b', 'l', 'v', 'Escape', 'ArrowLeft', `${mod}+0`, `${mod}+a`, `${mod}+/`]) await page.keyboard.press(key);
    await page.keyboard.type('hbl');
    // the select-all key selected the field's own text, which the typing then replaced: if the page had taken it, the selection below would differ
    expect(await page.locator('#probe-field').inputValue()).toBe('hbl');
    expect(await legendOpen(page), 'the legend').toBe(false);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await zoomOf(page), 'the zoom').toBe(before.zoom);
    expect(await description(page), 'the selection').toBe(before.selection);
    expect(await currentTool(page), 'the tool').toBe(before.tool);
  });
});

test.describe('the arrow keys', () => {
  test.beforeEach(async ({ page }) => {
    await openSample(page);
    await recordPrevented(page);
    await focusCanvas(page);
  });

  test('move nothing with the Pan tool, and nothing with only a relationship selected, and the browser keeps the key', async ({ page }) => {
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    await page.keyboard.press('h');
    const before = JSON.stringify(await positions(page));
    await page.keyboard.press('ArrowRight');
    expect(await lastPrevented(page), 'ArrowRight with the Pan tool').toBe(false);
    await page.keyboard.press('v');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await walkTo(page, / from /);
    await page.keyboard.press('Space');
    expect(await description(page)).toContain('1 selected');
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowDown');
    expect(await lastPrevented(page), 'ArrowDown with only a relationship selected').toBe(false);
    await page.waitForTimeout(200);
    expect(JSON.stringify(await positions(page))).toBe(before);
  });

  test('move each selected entity by 10 and by 50 with Shift, up being −y, leave a pinned one, and say what moved', async ({ page }) => {
    await page.keyboard.press('Enter');
    await walkTo(page, /^Jordan Lee/);
    await page.keyboard.press('Space');
    await walkTo(page, /, pinned$/);
    await page.keyboard.press('Shift+Space');
    await page.keyboard.press('Escape');
    expect(await description(page)).toContain('2 selected');
    const before = await positions(page);
    const key = (id: string): string => Object.keys(before).find((candidate) => candidate.endsWith(`,"${id}"]`)) ?? '';
    for (const [press, dx, dy] of [['ArrowRight', 10, 0], ['ArrowDown', 0, 10], ['ArrowUp', 0, -10], ['ArrowLeft', -10, 0], ['Shift+ArrowRight', 50, 0], ['Shift+ArrowUp', 0, -50]] as const) {
      const start = (await positions(page))[key('holder')];
      await page.keyboard.press(press);
      await expect.poll(async () => JSON.stringify((await positions(page))[key('holder')]), { message: press }).toBe(JSON.stringify({ x: (start?.x ?? 0) + dx, y: (start?.y ?? 0) + dy }));
    }
    expect((await positions(page))[key('gad-2')], 'the pinned entity did not move').toEqual(before[key('gad-2')]);
    await expect(announcement(page)).toHaveText('1 entity moved, 1 pinned stayed');
  });
});

test.describe('the workspace keys', () => {
  test.beforeEach(async ({ page }) => openSample(page));

  test('choose the tools, open and close the legend, and fit the view, with the platform modifier', async ({ page }) => {
    const mod = await modifier(page);
    for (const [key, tool] of [['h', 'Pan'], ['b', 'Box select'], ['v', 'Select']] as const) {
      await page.keyboard.press(key);
      expect(await currentTool(page), `${key} chooses ${tool}`).toContain(tool);
    }
    await page.keyboard.press('l');
    expect(await legendOpen(page)).toBe(true);
    await page.keyboard.press('l');
    expect(await legendOpen(page)).toBe(false);
    await page.keyboard.press(`${mod}+0`);
    await expect.poll(() => zoomOf(page), { message: 'the first fit' }).not.toBe(1);
    const fitted = await zoomOf(page);
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect.poll(() => zoomOf(page), { message: 'Zoom in changed the zoom' }).toBeGreaterThan(fitted);
    await page.keyboard.press(`${mod}+0`);
    await expect.poll(() => zoomOf(page), { message: 'the fit key brought the view back' }).toBeCloseTo(fitted, 2);
  });

  test('select all and invert the selection, counted in the canvas description', async ({ page }) => {
    const mod = await modifier(page);
    await focusCanvas(page);
    await page.keyboard.press(`${mod}+a`);
    expect(await description(page)).toContain('10 selected');
    await page.keyboard.press(`${mod}+Shift+i`);
    expect(await description(page)).not.toContain('selected');
    await page.keyboard.press(`${mod}+Shift+i`);
    expect(await description(page)).toContain('10 selected');
  });

  test('collapse and expand the dock panel with Enter, and resize it with the handle keys', async ({ page }) => {
    const toggle = page.getByRole('button', { name: /(Collapse|Expand) Dock test panel/ });
    await toggle.focus();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('A panel in the dock, beside the canvas.')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByText('A panel in the dock, beside the canvas.')).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('A panel in the dock, beside the canvas.')).toBeVisible();
    const handle = page.getByRole('separator', { name: 'Resize Dock test panel' });
    await handle.focus();
    const widths: string[] = [(await handle.getAttribute('aria-valuenow')) ?? ''];
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      await page.keyboard.press(key);
      widths.push((await handle.getAttribute('aria-valuenow')) ?? '');
    }
    expect(widths, 'the width after nothing, ArrowLeft, ArrowRight, Home, End').toEqual(['320', '336', '320', '240', '480']);
  });
});

test.describe('the sheet of shortcuts', () => {
  test.beforeEach(async ({ page }) => openSample(page));

  test('lists the registered bindings, keeps the focus inside, closes on Escape and gives the focus back', async ({ page }) => {
    const mod = await modifier(page);
    await focusCanvas(page);
    await page.keyboard.press(`${mod}+/`);
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    const mac = mod === 'Meta';
    const names: Record<string, string> = { escape: 'Esc', enter: 'Enter', space: 'Space', tab: 'Tab', delete: 'Del', contextmenu: 'Menu', arrowleft: '←', arrowup: '↑', arrowdown: '↓', arrowright: '→' };
    // how the sheet shows a key on this platform: ⇧⌘I on macOS, Ctrl+Shift+I elsewhere
    const shown = (spec: string): string => {
      const parts = spec.split('+');
      const last = parts.pop() ?? '';
      const name = names[last] ?? last.toUpperCase();
      const has = (word: string): boolean => parts.includes(word);
      return mac ? `${has('shift') ? '⇧' : ''}${has('mod') ? '⌘' : ''}${name}` : [...(has('mod') ? ['Ctrl'] : []), ...(has('shift') ? ['Shift'] : []), name].join('+');
    };
    const row = (label: string, ...specs: string[]): string => `${label} ${specs.map(shown).join(' ')}`;
    const rows = await dialog.locator('.sheet-row').evaluateAll((elements) => elements.map((element) => `${element.querySelector('.sheet-label')?.textContent ?? ''} ${[...element.querySelectorAll('.sheet-key')].map((chip) => chip.textContent ?? '').join(' ')}`));
    expect(rows).toEqual([
      row('Select', 'v'), row('Pan', 'h'), row('Box select', 'b'), row('Search', 'mod+k'), row('Legend', 'l'),
      row('Select all', 'mod+a'), row('Invert selection', 'mod+shift+i'), row('Clear', 'escape'), row('Expand', 'e'), row('Focus', 'f'),
      'Move selected entities ←↑↓→', `Move by 50 ${mac ? '⇧←↑↓→' : 'Shift+←↑↓→'}`, row('Select the element', 'enter', 'space'), row('Add to the selection', 'shift+enter', 'shift+space'),
      row('Pin position', 'p'), row('Hide', 'delete'), row('Copy ID', 'mod+c'), row('Find paths', 'shift+p'), row('Export view', 'mod+e'), row('Copy properties', 'mod+shift+c'), row('Open context menu', 'contextmenu', 'shift+f10'),
      row('Fit to view', 'mod+0'), row('Keyboard shortcuts', 'mod+/'), row('Walk the canvas', 'enter', 'space'), row('Next element', 'tab'), row('Previous element', 'shift+tab'), row('Leave the walk', 'escape'),
    ]);
    for (let press = 0; press < 4; press += 1) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((element) => element.contains(document.activeElement)), 'the focus stays inside the sheet').toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(canvasOf(page)).toBeFocused();
  });

  test('has stand-in rows that work from their keys, and the keys in the menus equal the bound keys', async ({ page }) => {
    const mod = await modifier(page);
    const root = page.locator('html');
    for (const [press, id] of [['e', 'expand'], ['f', 'focus'], ['p', 'pin'], ['Delete', 'hide'], [`${mod}+c`, 'copy-id'], ['Shift+p', 'find-paths'], [`${mod}+e`, 'export-view'], [`${mod}+Shift+c`, 'copy-properties']] as const) {
      await page.keyboard.press(press);
      await expect(root, `${press} reaches its stand-in`).toHaveAttribute('data-last-stand-in-key', id);
    }
    await focusCanvas(page);
    await page.keyboard.press('Enter');
    await page.keyboard.press('ContextMenu');
    const hints = await page.getByRole('menu').first().locator('[role="menuitem"]').evaluateAll((items) => items.map((item) => ({ label: item.querySelector('.menu-label')?.textContent ?? '', hint: item.querySelector('.menu-hint, kbd')?.textContent ?? '' })));
    const wanted = new Map([['Expand neighbors', 'E'], ['Focus neighborhood', 'F'], ['Pin position', 'P'], ['Hide from view', 'Del'], ['Invert selection', mod === 'Meta' ? '⇧⌘I' : 'Ctrl+Shift+I']]);
    const shown = hints.filter(({ label }) => wanted.has(label));
    expect(shown.length, 'the menu shows the hints that are bound').toBeGreaterThan(0);
    for (const { label, hint } of shown) expect(hint, `the hint of ${label}`).toBe(wanted.get(label));
  });
});
