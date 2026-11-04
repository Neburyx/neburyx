import type { BoxOverlay } from './box-gesture.js';

export const SELECTION_BOX_CLASS = 'selection-box';

/** A rectangle laid over the canvas element, shown while a box is being drawn and removed when the gesture ends. */
export function createBoxOverlay(container: HTMLElement): BoxOverlay & { dispose(): void } {
  let element: HTMLElement | undefined;
  return {
    show(box) {
      if (element === undefined) {
        element = container.ownerDocument.createElement('div');
        element.className = SELECTION_BOX_CLASS;
        container.append(element);
      }
      element.style.left = `${box.x1}px`;
      element.style.top = `${box.y1}px`;
      element.style.width = `${box.x2 - box.x1}px`;
      element.style.height = `${box.y2 - box.y1}px`;
    },
    hide() {
      element?.remove();
      element = undefined;
    },
    dispose() {
      element?.remove();
      element = undefined;
    },
  };
}
