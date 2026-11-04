import { describe, expect, it } from 'vitest';
import { createBoxOverlay, SELECTION_BOX_CLASS } from './box-overlay.js';

const boxes = (container: HTMLElement) => container.querySelectorAll(`.${SELECTION_BOX_CLASS}`);

describe('the box overlay', () => {
  it('lays one rectangle over the canvas at the box, moves it as the box changes, and removes it when hidden', () => {
    const container = document.createElement('div');
    const overlay = createBoxOverlay(container);
    overlay.show({ x1: 10, y1: 20, x2: 60, y2: 90 });
    overlay.show({ x1: 10, y1: 20, x2: 80, y2: 120 });
    expect(boxes(container)).toHaveLength(1);
    const element = boxes(container)[0];
    expect(element instanceof HTMLElement && [element.style.left, element.style.top, element.style.width, element.style.height]).toEqual(['10px', '20px', '70px', '100px']);
    overlay.hide();
    expect(boxes(container)).toHaveLength(0);
  });

  it('removes the rectangle when it is disposed while a box is showing, and hiding when none shows does nothing', () => {
    const container = document.createElement('div');
    const overlay = createBoxOverlay(container);
    overlay.hide();
    overlay.show({ x1: 0, y1: 0, x2: 5, y2: 5 });
    overlay.dispose();
    expect(boxes(container)).toHaveLength(0);
  });
});
