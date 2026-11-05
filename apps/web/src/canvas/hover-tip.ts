export const HOVER_TIP_CLASS = 'canvas-tip';

export interface TipContent {
  /** The first line, the title of an entity or the label of a relationship. */
  readonly title: string;
  /** The line under it, the type of an entity; none for a relationship. */
  readonly detail: string | undefined;
}

/** Where the tip hangs: the horizontal middle of its anchor, and the top, in the canvas element's own pixels. */
export interface TipAnchor {
  readonly x: number;
  readonly y: number;
}

export interface HoverTip {
  show(content: TipContent, anchor: TipAnchor): void;
  hide(): void;
  dispose(): void;
}

const MARGIN = 4;

/** A caption in the page's own text, laid over the canvas element and kept inside it, for an element whose drawn caption is too small to read. It takes no pointer events and is not announced: the walk announces what it is at. */
export function createHoverTip(container: HTMLElement): HoverTip {
  let element: HTMLElement | undefined;
  const hide = (): void => {
    element?.remove();
    element = undefined;
  };
  return {
    show({ title, detail }, { x, y }) {
      const tip = element ?? container.ownerDocument.createElement('div');
      if (element === undefined) {
        tip.className = HOVER_TIP_CLASS;
        tip.setAttribute('aria-hidden', 'true');
        container.append(tip);
        element = tip;
      }
      const lines = [title, ...(detail === undefined || detail === '' ? [] : [detail])];
      tip.replaceChildren(
        ...lines.map((line, index) => {
          const row = container.ownerDocument.createElement('p');
          row.className = index === 0 ? 'canvas-tip-title' : 'canvas-tip-detail';
          row.textContent = line;
          return row;
        }),
      );
      const left = Math.min(Math.max(x - tip.offsetWidth / 2, MARGIN), Math.max(container.clientWidth - tip.offsetWidth - MARGIN, MARGIN));
      const top = Math.min(Math.max(y, MARGIN), Math.max(container.clientHeight - tip.offsetHeight - MARGIN, MARGIN));
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    },
    hide,
    dispose: hide,
  };
}
