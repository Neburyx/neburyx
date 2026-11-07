import { expect, test } from '@playwright/test';
import { APPROXIMATE, boxOf, expectBox, expectContained, expectEachContained, expectInsideViewport, expectNoScroll, fromBottom, styleOf } from './support/regions.ts';

const PAGES = [
  ['Home', '/'],
  ['Investigations', '/investigations'],
  ['Sources', '/sources'],
] as const;

for (const [name, path] of PAGES) {
  test.describe(`the page shell of ${name}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(path);
      await expect(page.locator('h1')).toBeVisible();
      await expect(page.locator('.sidebar-bottom').getByText('Local workspace')).toBeVisible();
    });

    test('has no sideways scroll and keeps its regions inside the viewport and the sidebar still', async ({ page }) => {
      await expectInsideViewport(page, { sidebar: page.locator('aside.sidebar'), heading: page.locator('h1'), content: page.locator('main') });
      await expectNoScroll('the sidebar', page.locator('aside.sidebar'));
      await expectInsideViewport(page, { sidebar: page.locator('aside.sidebar') }, { bottom: true });
      await expectContained('the brand', page.locator('.brand'), page.locator('aside.sidebar'));
      await expectEachContained('a navigation item', page.locator('aside.sidebar nav a'), page.locator('aside.sidebar'));
      await expectContained('the identity block', page.locator('.sidebar-bottom'), page.locator('aside.sidebar'));
      await expectContained('the heading', page.locator('h1'), page.locator('main'));
      const heading = await page.locator('h1').evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, fontSize: parseFloat(getComputedStyle(element).fontSize) }));
      expect(heading.scrollHeight, 'the heading text is taller than its box').toBeLessThanOrEqual(heading.clientHeight + 1);
      expect(heading.scrollWidth, 'the heading text is wider than its box').toBeLessThanOrEqual(heading.clientWidth + 1);
      expect(heading.clientHeight, 'the heading box is shorter than its text').toBeGreaterThanOrEqual(heading.fontSize);
    });

    test('has the sidebar, brand and navigation of the frames', async ({ page }) => {
      const height = page.viewportSize()?.height ?? 0;
      await expectBox('sidebar', page.locator('aside.sidebar'), { x: 0, y: 0, width: 208, height });
      expect(await styleOf(page.locator('aside.sidebar'), ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']), 'sidebar padding').toEqual({ 'padding-top': '32px', 'padding-right': '16px', 'padding-bottom': '24px', 'padding-left': '16px' });
      await expectBox('brand', page.locator('.brand'), { x: 16, y: 32, width: 176, height: 29 });
      const items = page.locator('aside.sidebar nav a');
      await expect(items).toHaveCount(3);
      for (let index = 0; index < 3; index += 1) await expectBox(`navigation item ${index + 1}`, items.nth(index), { x: 16, y: 101 + 48 * index, width: 176, height: 40 });
    });

    test('marks the current item by the recorded fill, colour, weight and radius', async ({ page }) => {
      const current = page.locator('aside.sidebar a.active');
      await expect(current).toHaveCount(1);
      expect(await styleOf(current, ['background-color', 'color', 'font-weight', 'border-radius'])).toEqual({ 'background-color': 'rgb(234, 237, 247)', color: 'rgb(82, 100, 167)', 'font-weight': '500', 'border-radius': '6px' });
    });

    test('keeps the identity block anchored to the bottom, with one line and no edition line', async ({ page }) => {
      const divider = page.locator('.sidebar-bottom section').last();
      expect(Math.abs((await fromBottom(page, divider)) - 62), 'the divider above the identity').toBeLessThanOrEqual(APPROXIMATE);
      const lines = divider.locator('p');
      await expect(lines).toHaveCount(1);
      await expect(lines).toHaveText('Local workspace');
      expect(Math.abs((await fromBottom(page, lines.nth(0))) - 41), 'the identity line').toBeLessThanOrEqual(APPROXIMATE);
      await expect(page.getByText(/edition/i)).toHaveCount(0);
    });

    test('has the heading and the content padding of the frames, and no width that follows the font is compared', async ({ page }) => {
      const heading = page.locator('h1');
      expect(await styleOf(heading, ['font-size', 'font-weight'])).toEqual({ 'font-size': '28px', 'font-weight': '600' });
      await expectBox('heading', heading, { x: 248, y: 40 });
      expect(await styleOf(page.locator('main'), ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']), 'content padding').toEqual({ 'padding-top': '40px', 'padding-right': '40px', 'padding-bottom': '32px', 'padding-left': '40px' });
    });
  });
}

test('a long source name wraps in the sidebar line and moves nothing else', async ({ page }) => {
  await page.route('**/v1/sources', async (route) => {
    const reply = await route.fetch();
    const body: { items: Array<{ alias: string }> } = await reply.json();
    for (const item of body.items) item.alias = 'a-source-with-a-very-long-name-that-does-not-fit-on-one-line-of-the-sidebar';
    await route.fulfill({ response: reply, json: body });
  });
  await page.goto('/sources');
  const line = page.locator('.sidebar-bottom section').first();
  await expect(line).toContainText('a-source-with-a-very-long-name');
  const box = await boxOf(line);
  expect(box.height, 'the source line wraps onto more than one line').toBeGreaterThan(34.8);
  expect(box.width, 'the source line stays inside the sidebar').toBeLessThanOrEqual(176);
  await expectBox('the first navigation item', page.locator('aside.sidebar nav a').first(), { x: 16, y: 101, width: 176, height: 40 });
  await expectBox('heading', page.locator('h1'), { x: 248, y: 40 });
  await expectNoScroll('the sidebar', page.locator('aside.sidebar'));
});
