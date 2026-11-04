import { describe, expect, it } from 'vitest';
import { suppressNativeMenu } from './native-menu.js';

const rightClick = (element: HTMLElement): MouseEvent => {
  const event = new MouseEvent('contextmenu', { cancelable: true, bubbles: true });
  element.dispatchEvent(event);
  return event;
};

describe('suppressing the browser menu', () => {
  it('lets the browser menu open on an element nothing was done to', () => {
    expect(rightClick(document.createElement('div')).defaultPrevented).toBe(false);
  });

  it('cancels the browser menu on the element and on what it holds, and lets it open again when the returned function is called', () => {
    const element = document.createElement('div');
    const child = document.createElement('canvas');
    element.append(child);
    const restore = suppressNativeMenu(element);
    expect(rightClick(element).defaultPrevented).toBe(true);
    expect(rightClick(child).defaultPrevented).toBe(true);
    restore();
    expect(rightClick(element).defaultPrevented).toBe(false);
  });
});
