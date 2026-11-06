import type { Locator, Page } from '@playwright/test';

export const LOOK_PROPERTIES = [
  'display', 'height', 'min-height', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-top-style', 'border-top-color', 'border-right-width', 'border-bottom-width', 'border-bottom-color', 'border-left-width', 'border-left-color',
  'border-top-left-radius', 'border-bottom-right-radius', 'background-color', 'background-image', 'color', 'font-family', 'font-size', 'font-weight', 'line-height',
  'cursor', 'opacity', 'appearance', 'text-decoration-line', 'gap', 'align-items', 'outline-style',
] as const;

export async function tokenColour(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, token);
}

export async function tokenLength(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.width = `var(${name})`;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).width;
    probe.remove();
    return resolved;
  }, token);
}

export async function lookOf(control: Locator, properties: readonly string[] = LOOK_PROPERTIES): Promise<Record<string, string>> {
  return control.evaluate((element, names) => Object.fromEntries(names.map((name) => [name, getComputedStyle(element).getPropertyValue(name)])), properties);
}

export async function addPlainControls(page: Page): Promise<void> {
  await page.evaluate(() => {
    const holder = document.createElement('div');
    holder.id = 'plain-controls';
    holder.innerHTML = `
      <button type="button">Plain button</button>
      <button type="button" class="">Empty class</button>
      <button type="button" class="primary">Primary</button>
      <button type="button" class="secondary">Secondary</button>
      <button type="button" class="link">Link</button>
      <select aria-label="Plain selector"><option>one</option><option>two</option></select>
      <input aria-label="Plain field" placeholder="Plain field" />
      <input type="search" aria-label="Plain search" />
      <button type="button" disabled>Disabled</button>
      <button type="button" aria-disabled="true">Aria disabled</button>
      <button type="button" aria-busy="true" aria-disabled="true" class="primary">Busy primary</button>
      <button type="button" disabled class="link">Disabled link</button>
      <button type="button" disabled class="primary">Disabled primary</button>`;
    (document.querySelector('main') ?? document.body).prepend(holder);
  });
}

/** Takes the shared default-look rules out of the page's style sheets, runs `read`, then puts them back. */
export async function withoutDefaultRules<T>(page: Page, read: () => Promise<T>): Promise<T> {
  const removed = await page.evaluate(() => {
    const taken: Array<{ sheet: number; index: number; text: string }> = [];
    Array.from(document.styleSheets).forEach((sheet, sheetIndex) => {
      const rules = Array.from(sheet.cssRules);
      for (let index = rules.length - 1; index >= 0; index -= 1) {
        const rule = rules[index];
        if (rule instanceof CSSStyleRule && rule.selectorText.startsWith(':where(')) {
          taken.push({ sheet: sheetIndex, index, text: rule.cssText });
          sheet.deleteRule(index);
        }
      }
    });
    return taken;
  });
  try {
    return await read();
  } finally {
    await page.evaluate((taken) => {
      for (const { sheet, index, text } of taken.slice().reverse()) document.styleSheets[sheet]?.insertRule(text, index);
    }, removed);
  }
}
