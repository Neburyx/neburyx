import { expect, test } from '@playwright/test';
import { announcement, canvasOf, drawing, focusCanvas, lastPrevented, menuItems, menuOf, openSample, positions, recordPrevented, screenOf, tabTo } from './support/workspace.ts';

const description = async (page: import('@playwright/test').Page): Promise<string> => (await canvasOf(page).evaluate((element) => document.getElementById(element.getAttribute('aria-describedby') ?? '')?.textContent ?? '')) ?? '';

test.describe('keys that are not for the canvas', () => {
  test.beforeEach(async ({ page }) => {
    await openSample(page);
    await recordPrevented(page);
  });

  test('do nothing with the focus on the page body or on a button, and the browser keeps the key', async ({ page }) => {
    // an entity is selected, so that a binding that was widened beyond the canvas would have something to move
    await focusCanvas(page);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    expect(await description(page)).toContain('1 selected');
    const before = JSON.stringify(await positions(page));
    for (const place of ['body', 'button']) {
      await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
      if (place === 'button') await page.getByRole('button', { name: 'Zoom in' }).focus();
      for (const key of ['ContextMenu', 'Shift+F10', 'ArrowRight', 'ArrowUp', 'Shift+ArrowLeft']) {
        await page.keyboard.press(key);
        expect(await lastPrevented(page), `${key} with the focus on the ${place}`).toBe(false);
        await expect(menuOf(page), `${key} with the focus on the ${place} opened a menu`).toHaveCount(0);
      }
      await expect(announcement(page)).toHaveText('');
    }
    await page.waitForTimeout(200);
    expect(JSON.stringify(await positions(page)), 'an arrow outside the canvas moved the selection').toBe(before);
  });

  test('leave Tab to the browser when the walk is off, and still run the workspace keys where the focus is not a text field', async ({ page }) => {
    await focusCanvas(page);
    await page.keyboard.press('Tab');
    expect(await lastPrevented(page), 'Tab with the walk off').toBe(false);
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await page.keyboard.press('l');
    await expect(page.getByRole('button', { name: 'Close Legend' })).toBeVisible();
    await page.keyboard.press('l');
    await expect(page.getByRole('button', { name: 'Close Legend' })).toHaveCount(0);
  });
});

test.describe('the canvas as a tab stop', () => {
  test('is one stop with a visible ring, and Tab and Shift+Tab leave it, with a graph', async ({ page }) => {
    await openSample(page);
    const canvas = canvasOf(page);
    await expect(canvas).toHaveAttribute('tabindex', '0');
    await focusCanvas(page);
    expect(await canvas.evaluate((element) => element.matches(':focus-visible')), 'the keyboard ring').toBe(true);
    const ring = await canvas.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), color: style.outlineColor };
    });
    expect(ring.style, 'the ring is drawn').toBe('solid');
    expect(ring.width, 'the ring has a width').toBeGreaterThan(0);
    const channels = (ring.color.match(/[\d.]+/g) ?? []).map(Number);
    expect(channels.length === 3 || (channels.length === 4 && (channels[3] ?? 0) > 0), `the ring colour ${ring.color} is not transparent`).toBe(true);
    await page.keyboard.press('Tab');
    expect(await canvas.evaluate((element) => element === document.activeElement), 'Tab left the canvas').toBe(false);
    await page.keyboard.press('Shift+Tab');
    expect(await canvas.evaluate((element) => element === document.activeElement), 'Shift+Tab came back').toBe(true);
    await page.keyboard.press('Shift+Tab');
    expect(await canvas.evaluate((element) => element === document.activeElement), 'Shift+Tab left it again').toBe(false);
  });

  test('is a stop that can be left with nothing loaded', async ({ page }) => {
    await page.goto('/explore');
    const canvas = canvasOf(page);
    await expect(canvas).toBeVisible();
    await focusCanvas(page);
    await page.keyboard.press('Tab');
    expect(await canvas.evaluate((element) => element === document.activeElement)).toBe(false);
    await page.keyboard.press('Enter');
    await expect(announcement(page)).toHaveText('');
  });
});

test.describe('the walk', () => {
  test.beforeEach(async ({ page }) => {
    await openSample(page);
    await focusCanvas(page);
  });

  const ENTITY_ORDER = ['Jordan Lee, Holder', 'LED-48291, Ledger', 'LED-71825, Ledger', 'CAS-20348, Case file', 'TRN-99381, Transfer', 'SEL-231, Seller', 'GAD-884, Gadget', 'GAD-217, Gadget, pinned', '198.51.100.42, Network host', 'LIN-1042, Line'];
  const RELATIONSHIP_ORDER = [
    'HAS_LINE, from Jordan Lee to LIN-1042',
    'HOLDS, from Jordan Lee to LED-48291',
    'FILES, from Jordan Lee to CAS-20348',
    'CONTESTS, from CAS-20348 to TRN-99381',
    'SENDS, from LED-48291 to TRN-99381',
    'PAYS, from TRN-99381 to SEL-231',
    'USES_GADGET · 42 · exact, from LED-48291 to GAD-884',
    'USES_GADGET, from LED-71825 to GAD-884',
    'SEEN_AT, from GAD-884 to 198.51.100.42',
    'SEEN_AT, from GAD-217 to 198.51.100.42',
    'USES_GADGET, from LED-71825 to GAD-217',
    'USES_GADGET, from LED-48291 to GAD-217',
    'SHARED_GADGET · derived, from LED-48291 to LED-71825',
  ];

  test.describe.configure({ mode: 'serial' });

  for (const entry of ['Enter', 'Space']) {
    test(`starts with ${entry} at the first entity, visits each entity and then each relationship once in their order, wraps, and draws the ring on the element it announces`, async ({ page }) => {
      const canvas = canvasOf(page);
      await page.keyboard.press(entry);
      const seen: string[] = [];
      for (let step = 0; step < ENTITY_ORDER.length + RELATIONSHIP_ORDER.length; step += 1) {
        const said = (await announcement(page).textContent()) ?? '';
        seen.push(said);
        const now = await drawing(page);
        const ringed = [...now.nodes.filter((node) => node.focused).map((node) => node.id), ...now.edges.filter((edge) => edge.focused).map((edge) => edge.id)];
        expect(ringed, `the ring after "${said}"`).toHaveLength(1);
        await expect(canvas, `the element named in the read-out after "${said}"`).toHaveAttribute('data-focused-element', ringed[0] ?? '');
        await page.keyboard.press('Tab');
      }
      expect(seen, 'the walk, in order, each element once').toEqual([...ENTITY_ORDER, ...RELATIONSHIP_ORDER]);
      await expect(announcement(page), 'after the last relationship the walk wraps to the first entity').toHaveText(ENTITY_ORDER[0] ?? '');
      await page.keyboard.press('Shift+Tab');
      await expect(announcement(page), 'Shift+Tab wraps back to the last relationship').toHaveText(RELATIONSHIP_ORDER.at(-1) ?? '');
    });
  }

  test('selects as a click does, adds with Shift, keeps the selection when Escape leaves the walk and clears it with the next Escape', async ({ page }) => {
    const canvas = canvasOf(page);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    expect(await description(page)).toContain('1 selected');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Space');
    expect(await description(page)).toContain('2 selected');
    await page.keyboard.press('Shift+Enter');
    expect(await description(page), 'Shift+Enter on a selected element takes it out').toContain('1 selected');
    await page.keyboard.press('Shift+Space');
    await page.keyboard.press('Escape');
    await expect(canvas).not.toHaveAttribute('data-focused-element', /.+/);
    expect(await description(page), 'Escape left the walk and kept the selection').toContain('2 selected');
    await page.keyboard.press('Escape');
    expect(await description(page), 'a second Escape on the canvas clears it').not.toContain('selected');
  });
});

test.describe('the context menu from the keys', () => {
  test.beforeEach(async ({ page }) => {
    await openSample(page);
    await focusCanvas(page);
  });

  test('opens the menu of the walked entity with the items of a right-click on it, from the menu key and from Shift+F10, and no second one', async ({ page }) => {
    await page.keyboard.press('Enter');
    for (const key of ['ContextMenu', 'Shift+F10']) {
      await page.keyboard.press(key);
      await expect(menuOf(page)).toHaveCount(1);
      const byKey = await menuItems(page);
      expect(byKey.length, 'the entity menu has items').toBeGreaterThan(0);
      await page.keyboard.press(key);
      await expect(menuOf(page), 'a second press opens no second menu').toHaveCount(1);
      await page.keyboard.press('Escape');
      await expect(menuOf(page)).toHaveCount(0);
      await expect(canvasOf(page), 'the focus is back on the canvas').toBeFocused();
      const at = await screenOf(page, 'holder');
      await page.mouse.click(at.x, at.y, { button: 'right' });
      await expect(menuOf(page)).toHaveCount(1);
      expect(await menuItems(page), `${key}: the items of a right-click on the same entity`).toEqual(byKey);
      await page.keyboard.press('Escape');
      await tabTo(page, canvasOf(page));
      await page.keyboard.press('Enter');
    }
  });

  test('opens the menu of the walked relationship and the canvas menu with the walk off, each with the items of a right-click', async ({ page }) => {
    await page.keyboard.press('Enter');
    for (let step = 0; step < 40; step += 1) {
      await page.keyboard.press('Tab');
      if (((await announcement(page).textContent()) ?? '').startsWith('HAS_LINE')) break;
    }
    await expect(announcement(page)).toHaveText('HAS_LINE, from Jordan Lee to LIN-1042');
    await page.keyboard.press('ContextMenu');
    await expect(menuOf(page)).toHaveCount(1);
    const relationship = await menuItems(page);
    await page.keyboard.press('Escape');
    const from = await screenOf(page, 'holder');
    const to = await screenOf(page, 'lin');
    await page.mouse.click((from.x + to.x) / 2, (from.y + to.y) / 2, { button: 'right' });
    await expect(menuOf(page)).toHaveCount(1);
    expect(await menuItems(page), 'the items of a right-click on the same relationship').toEqual(relationship);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.keyboard.press('ContextMenu');
    await expect(menuOf(page)).toHaveCount(1);
    const canvasMenu = await menuItems(page);
    await page.keyboard.press('Escape');
    const box = await canvasOf(page).boundingBox();
    await page.mouse.click((box?.x ?? 0) + (box?.width ?? 0) - 40, (box?.y ?? 0) + (box?.height ?? 0) - 120, { button: 'right' });
    await expect(menuOf(page)).toHaveCount(1);
    expect(await menuItems(page), 'the items of a right-click on empty canvas').toEqual(canvasMenu);
  });

  test('closes a submenu first and then the menu, leaves the selection each time, and returns the focus to the canvas after a chosen command', async ({ page }) => {
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    expect(await description(page)).toContain('1 selected');
    await page.keyboard.press('ContextMenu');
    await expect(menuOf(page)).toHaveCount(1);
    const submenu = menuOf(page).first().getByRole('menuitem', { name: 'Expand by neighbor type' });
    await submenu.focus();
    await page.keyboard.press('ArrowRight');
    await expect(submenu, 'the submenu opened').toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(submenu, 'one Escape closes the submenu only').toHaveAttribute('aria-expanded', 'false');
    await expect(menuOf(page)).toHaveCount(1);
    expect(await description(page)).toContain('1 selected');
    await page.keyboard.press('Escape');
    await expect(menuOf(page)).toHaveCount(0);
    expect(await description(page)).toContain('1 selected');
    await expect(canvasOf(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await page.keyboard.press('ContextMenu');
    await expect(menuOf(page)).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(menuOf(page)).toHaveCount(0);
    await expect(canvasOf(page), 'a chosen command returns the focus').toBeFocused();
  });

  test('closes the Explore flyout on Escape, returns the focus to the Explore button and leaves the selection', async ({ page }) => {
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    await tabTo(page, page.getByRole('button', { name: 'Explore' }));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Explore' })).toBeFocused();
    expect(await description(page)).toContain('1 selected');
  });
});
