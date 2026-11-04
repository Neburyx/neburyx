import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FlyoutBoundary } from './flyout-boundary.js';
import { placeSubmenu, type Placement } from './menu-placement.js';
import type { MenuContext, RegisteredMenuItem } from './menu-registry.js';

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface SubmenuProps {
  readonly item: RegisteredMenuItem;
  readonly row: HTMLElement;
  readonly takeFocus: boolean;
  readonly context: MenuContext;
  readonly close: () => void;
  readonly closeAll: () => void;
}

/** The content of a submenu, beside the row it belongs to; content that throws closes only this submenu. */
export function Submenu({ item, row, takeFocus, context, close, closeAll }: SubmenuProps) {
  const holder = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | undefined>(undefined);
  const [, remeasure] = useState(0);
  useLayoutEffect(() => {
    const element = holder.current;
    if (element === null) return;
    const size = element.getBoundingClientRect();
    const next = placeSubmenu(row.getBoundingClientRect(), { width: size.width, height: size.height }, { width: window.innerWidth, height: window.innerHeight });
    if (placement === undefined || placement.left !== next.left || placement.top !== next.top) setPlacement(next);
  });
  useEffect(() => {
    const element = holder.current;
    if (element === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => remeasure((count) => count + 1));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const placed = placement !== undefined;
  useEffect(() => {
    if (!takeFocus || !placed) return;
    const candidates = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    for (const candidate of candidates) {
      candidate.focus();
      if (document.activeElement === candidate) return;
    }
    panel.current?.focus();
  }, [takeFocus, placed]);
  const Content = item.submenu;
  if (Content === undefined) return null;
  return (
    <div className="context-submenu" ref={holder} style={placement === undefined ? { left: 0, top: 0, visibility: 'hidden' } : { left: placement.left, top: placement.top }}>
      <div className="menu-panel" tabIndex={-1} ref={panel}>
        <FlyoutBoundary key={item.id} onFailure={close}>
          <Content context={context} close={closeAll} />
        </FlyoutBoundary>
      </div>
    </div>
  );
}
