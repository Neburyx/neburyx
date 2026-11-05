import { afterEach, describe, expect, it } from 'vitest';
import { createHoverTip, HOVER_TIP_CLASS } from './hover-tip.js';

const made: HTMLElement[] = [];

function surface(width = 400, height = 300): HTMLElement {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: width });
  Object.defineProperty(container, 'clientHeight', { value: height });
  document.body.append(container);
  made.push(container);
  return container;
}

afterEach(() => {
  for (const container of made.splice(0)) container.remove();
});

const tipIn = (container: HTMLElement): HTMLElement | null => container.querySelector(`.${HOVER_TIP_CLASS}`);

describe('the hover tip', () => {
  it('is not there until it is shown, and is gone when hidden or disposed', () => {
    const container = surface();
    const tip = createHoverTip(container);
    expect(tipIn(container)).toBeNull();
    tip.hide();
    tip.show({ title: 'GAD-217', detail: 'Gadget' }, { x: 100, y: 100 });
    expect(tipIn(container)).not.toBeNull();
    tip.hide();
    expect(tipIn(container)).toBeNull();
    tip.show({ title: 'GAD-217', detail: undefined }, { x: 100, y: 100 });
    tip.dispose();
    expect(tipIn(container)).toBeNull();
  });

  it('shows a title and a detail line, or the title alone, as text and never as markup, aria-hidden and without taking the pointer', () => {
    const container = surface();
    const tip = createHoverTip(container);
    tip.show({ title: '<b>x</b>', detail: '<i>y</i>' }, { x: 100, y: 100 });
    const shown = tipIn(container);
    expect([...(shown?.querySelectorAll('p') ?? [])].map((line) => [line.className, line.textContent])).toEqual([['canvas-tip-title', '<b>x</b>'], ['canvas-tip-detail', '<i>y</i>']]);
    expect(shown?.querySelector('b, i')).toBeNull();
    expect(shown?.getAttribute('aria-hidden')).toBe('true');
    tip.show({ title: 'USES', detail: undefined }, { x: 100, y: 100 });
    expect(container.querySelectorAll(`.${HOVER_TIP_CLASS}`)).toHaveLength(1);
    expect([...(tipIn(container)?.querySelectorAll('p') ?? [])].map((line) => line.textContent)).toEqual(['USES']);
  });

  it('hangs from the anchor, centred, and stays inside the canvas element on every side', () => {
    const container = surface(400, 300);
    const tip = createHoverTip(container);
    const place = (x: number, y: number): [string, string] => {
      tip.show({ title: 'GAD-217', detail: 'Gadget' }, { x, y });
      const shown = tipIn(container);
      Object.defineProperty(shown, 'offsetWidth', { value: 100, configurable: true });
      Object.defineProperty(shown, 'offsetHeight', { value: 40, configurable: true });
      tip.show({ title: 'GAD-217', detail: 'Gadget' }, { x, y });
      return [shown?.style.left ?? '', shown?.style.top ?? ''];
    };
    expect(place(200, 100)).toEqual(['150px', '100px']);
    expect(place(10, 100)).toEqual(['4px', '100px']);
    expect(place(395, 100)).toEqual(['296px', '100px']);
    expect(place(200, -50)).toEqual(['150px', '4px']);
    expect(place(200, 500)).toEqual(['150px', '256px']);
  });
});
