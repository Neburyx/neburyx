import type { Page } from '@playwright/test';

export interface DefaultLook {
  readonly control: string;
  readonly classes: string;
}

/** What a control that the product styled differs in from the browser's own: if all of these are equal to a fresh control of the same kind, it was left as the browser draws it. */
const LOOK = ['background-color', 'border-top-style', 'border-top-width', 'border-top-color', 'border-top-left-radius'] as const;

/** The visible buttons, selectors and text fields of the page whose look is the browser's own, measured against fresh controls in an empty frame. */
export async function findDefaultLooks(page: Page): Promise<DefaultLook[]> {
  return page.evaluate((properties) => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    document.body.append(frame);
    const inner = frame.contentDocument;
    const innerWindow = frame.contentWindow;
    if (inner === null || innerWindow === null) throw new Error('THE_EMPTY_FRAME_HAS_NO_DOCUMENT');
    const fresh = new Map<string, Record<string, string>>();
    const kinds: ReadonlyArray<readonly [string, () => HTMLElement]> = [
      ['button', () => inner.createElement('button')],
      ['select', () => inner.createElement('select')],
      ['input:text', () => Object.assign(inner.createElement('input'), { type: 'text' })],
      ['input:search', () => Object.assign(inner.createElement('input'), { type: 'search' })],
    ];
    for (const [kind, make] of kinds) {
      const element = make();
      inner.body.append(element);
      const style = innerWindow.getComputedStyle(element);
      fresh.set(kind, Object.fromEntries(properties.map((name) => [name, style.getPropertyValue(name)])));
    }
    const found: Array<{ control: string; classes: string }> = [];
    for (const element of Array.from(document.querySelectorAll('button, select, input'))) {
      const tag = element.tagName.toLowerCase();
      const type = element instanceof HTMLInputElement ? (element.type === '' ? 'text' : element.type) : '';
      const kind = tag === 'input' ? `input:${type}` : tag;
      const reference = fresh.get(kind);
      if (reference === undefined || element.ownerDocument !== document) continue;
      const style = getComputedStyle(element);
      if (element.getClientRects().length === 0 || style.visibility === 'hidden') continue;
      if (properties.every((name) => style.getPropertyValue(name) === reference[name])) {
        const name = element.getAttribute('aria-label') ?? element.getAttribute('placeholder') ?? (element.textContent ?? '').trim();
        found.push({ control: `${kind} "${name.slice(0, 40)}"`, classes: element.getAttribute('class') ?? '' });
      }
    }
    frame.remove();
    return found;
  }, LOOK);
}

export function describeFinding(finding: DefaultLook): string {
  return `${finding.control}${finding.classes === '' ? '' : ` with the class "${finding.classes}"`}: it has the browser's default look; a class used for layout only belongs on a wrapper, not on the control`;
}
