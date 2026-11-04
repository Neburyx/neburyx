import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCanvasCommands } from '../canvas/canvas-commands.js';
import { useProfile } from '../canvas/profile-context.js';
import { answeredData, useShellData } from '../shell/shell-data.js';
import { useClientState, useLoadedGraph } from '../state/context.js';
import { drawnKeys } from '../state/loaded-graph.js';
import type { OpenMenu } from '../state/presentation-state.js';
import { useStoreSelector } from '../state/store.js';
import { LOCK_TOOLTIP } from './locked-control.js';
import { menuHeader } from './menu-header.js';
import { placeMenu, type Placement } from './menu-placement.js';
import { useMenuItems, type MenuContext, type RegisteredMenuItem } from './menu-registry.js';
import { Submenu } from './menu-submenu.js';

const CANVAS_MENU_NAME = 'Canvas';
const ROWS = ':scope > .menu-panel > [role="menuitem"]';

interface SubmenuOpen {
  readonly menu: OpenMenu;
  readonly id: string;
  readonly registration: number;
  readonly row: HTMLElement;
  readonly takeFocus: boolean;
}

export function ContextMenu() {
  const state = useClientState();
  const canvas = useCanvasCommands();
  const open = useStoreSelector(state.presentation.view, (current) => current.openMenu);
  const items = useMenuItems(open?.kind);
  const graph = useLoadedGraph();
  const profile = useProfile();
  const headingId = useId();
  const edition = answeredData(useShellData().me)?.edition;
  const targetGone = open !== undefined && open.key !== undefined && !drawnKeys(graph).has(open.key);
  const shown = targetGone ? undefined : open;
  const root = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const focusedFor = useRef<OpenMenu | undefined>(undefined);
  const [placement, setPlacement] = useState<Placement | undefined>(undefined);
  const [, remeasure] = useState(0);
  const [submenuOpen, setSubmenuOpen] = useState<SubmenuOpen | undefined>(undefined);
  const parent = submenuOpen === undefined || submenuOpen.menu !== shown ? undefined : items.find((item) => item.id === submenuOpen.id && item.registration === submenuOpen.registration && item.submenu !== undefined && (item.state ?? 'enabled') === 'enabled');
  const activeSubmenu = parent === undefined || submenuOpen === undefined ? undefined : { item: parent, row: submenuOpen.row, takeFocus: submenuOpen.takeFocus };
  const activeNow = useRef(activeSubmenu);
  activeNow.current = activeSubmenu;
  const lastSubmenuRow = useRef<HTMLElement | undefined>(undefined);
  const isOpen = shown !== undefined;
  const placed = placement !== undefined;

  const restoreFocus = (): void => {
    const target = returnTo.current;
    returnTo.current = null;
    if (target !== null && target.isConnected) target.focus();
  };
  const closeMenu = (restore: boolean): void => {
    state.presentation.setOpenMenu(undefined);
    if (restore) restoreFocus();
  };
  const focusFirstRow = (): void => {
    const panel = root.current?.querySelector<HTMLElement>(':scope > .menu-panel');
    const rows = [...(root.current?.querySelectorAll<HTMLElement>(ROWS) ?? [])];
    (rows.find((row) => row.getAttribute('aria-disabled') !== 'true') ?? rows[0] ?? panel)?.focus();
  };

  useEffect(() => {
    if (open !== undefined && targetGone && state.presentation.view.getState().openMenu === open) state.presentation.setOpenMenu(undefined);
  }, [open, targetGone, state]);
  useEffect(() => {
    if (submenuOpen !== undefined && activeSubmenu === undefined) setSubmenuOpen(undefined);
  });
  useLayoutEffect(() => {
    if (!isOpen) return undefined;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      focusedFor.current = undefined;
    };
  }, [isOpen]);
  useLayoutEffect(() => {
    const holder = root.current;
    if (shown === undefined || holder === null) {
      if (placement !== undefined) setPlacement(undefined);
      return;
    }
    const size = holder.getBoundingClientRect();
    const next = placeMenu({ x: shown.x, y: shown.y }, { width: size.width, height: size.height }, { width: window.innerWidth, height: window.innerHeight });
    if (placement === undefined || placement.left !== next.left || placement.top !== next.top) setPlacement(next);
  });
  useEffect(() => {
    const holder = root.current;
    if (!isOpen || holder === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => remeasure((count) => count + 1));
    observer.observe(holder);
    return () => observer.disconnect();
  }, [isOpen]);
  useEffect(() => {
    if (shown === undefined || !placed || focusedFor.current === shown) return;
    focusedFor.current = shown;
    focusFirstRow();
  }, [shown, placed]);
  useEffect(() => {
    if (shown !== undefined && placed && focusedFor.current === shown && document.activeElement === document.body) focusFirstRow();
  }, [items]);
  useEffect(() => {
    const previous = lastSubmenuRow.current;
    lastSubmenuRow.current = activeSubmenu?.row;
    if (previous === undefined || previous === activeSubmenu?.row || !isOpen || document.activeElement !== document.body) return;
    const target = [activeSubmenu?.row, previous].find((row) => row?.isConnected === true);
    if (target === undefined) focusFirstRow();
    else target.focus();
  });
  useEffect(() => {
    if (!isOpen) return undefined;
    const closeWithoutRestoring = (): void => closeMenu(false);
    const insideMenu = (event: Event): boolean => event.target instanceof Node && root.current?.contains(event.target) === true;
    // A right-button press outside starts a new menu when it lands on the canvas, so the open menu is only closed once the press is released and nothing replaced it.
    let pressedOn: OpenMenu | undefined;
    const closeOnOutsidePress = (event: PointerEvent): void => {
      if (insideMenu(event)) return;
      if (event.button === 2) pressedOn = state.presentation.view.getState().openMenu;
      else closeMenu(false);
    };
    const closeAfterOutsideRightPress = (event: PointerEvent): void => {
      const pressed = pressedOn;
      pressedOn = undefined;
      if (pressed === undefined || event.button !== 2) return;
      setTimeout(() => {
        if (state.presentation.view.getState().openMenu === pressed) closeMenu(false);
      }, 0);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        const submenu = activeNow.current;
        if (submenu === undefined) closeMenu(true);
        else {
          setSubmenuOpen(undefined);
          submenu.row.focus();
        }
      } else if (event.key === 'Tab') {
        closeMenu(true);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePress, true);
    document.addEventListener('pointerup', closeAfterOutsideRightPress, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', closeWithoutRestoring);
    window.addEventListener('blur', closeWithoutRestoring);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress, true);
      document.removeEventListener('pointerup', closeAfterOutsideRightPress, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', closeWithoutRestoring);
      window.removeEventListener('blur', closeWithoutRestoring);
    };
  }, [isOpen, state]);

  if (shown === undefined) return null;
  const header = menuHeader(shown, graph, profile);
  const contextNow = (): MenuContext => ({ kind: shown.kind, key: shown.key, selection: [...state.presentation.view.getState().selection], state, canvas });
  const labelOf = (item: RegisteredMenuItem): string => (typeof item.label === 'function' ? item.label(contextNow()) : item.label);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest('.context-submenu') !== null) {
      const submenu = activeNow.current;
      if (event.key === 'ArrowLeft' && submenu !== undefined) {
        event.preventDefault();
        setSubmenuOpen(undefined);
        submenu.row.focus();
      }
      return;
    }
    if (event.key === 'ArrowRight' && target.getAttribute('aria-haspopup') === 'menu') {
      event.preventDefault();
      target.click();
      return;
    }
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(ROWS)];
    const next = { ArrowDown: rows.indexOf(target) + 1, ArrowUp: rows.indexOf(target) - 1, Home: 0, End: rows.length - 1 }[event.key];
    if (next === undefined || rows.length === 0) return;
    event.preventDefault();
    rows[(next + rows.length) % rows.length]?.focus();
  };

  return (
    <div
      className={`context-menu context-menu-${shown.kind}`}
      ref={root}
      style={placement === undefined ? { left: 0, top: 0, visibility: 'hidden' } : { left: placement.left, top: placement.top }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={onKeyDown}
    >
      <div
        className="menu-panel"
        role="menu"
        tabIndex={-1}
        aria-label={header === undefined ? CANVAS_MENU_NAME : undefined}
        aria-labelledby={header === undefined ? undefined : headingId}
        onScroll={() => setSubmenuOpen(undefined)}
      >
        {header === undefined ? null : (
          <div className="menu-header">
            <p className="menu-header-title" id={headingId}>
              {header.title}
            </p>
            <p className="menu-header-detail">{header.detail}</p>
          </div>
        )}
        {items.map((item, at) => {
          const status = item.state ?? 'enabled';
          const inert = status !== 'enabled';
          const opensSubmenu = item.submenu !== undefined;
          return (
            <Fragment key={item.id}>
              {at > 0 && items[at - 1]?.group !== item.group ? <div className="menu-separator" role="separator" /> : null}
              <button
                type="button"
                role="menuitem"
                className={`menu-row${status === 'enabled' ? '' : ` menu-row-${status}`}`}
                aria-disabled={inert ? true : undefined}
                aria-haspopup={opensSubmenu ? 'menu' : undefined}
                aria-expanded={opensSubmenu ? activeSubmenu?.item === item : undefined}
                tabIndex={-1}
                onPointerEnter={(event) => setSubmenuOpen(opensSubmenu && !inert ? { menu: shown, id: item.id, registration: item.registration, row: event.currentTarget, takeFocus: false } : undefined)}
                onClick={(event) => {
                  if (inert) return;
                  if (opensSubmenu) {
                    setSubmenuOpen({ menu: shown, id: item.id, registration: item.registration, row: event.currentTarget, takeFocus: true });
                    return;
                  }
                  const context = contextNow();
                  closeMenu(false);
                  item.run?.(context);
                  restoreFocus();
                }}
              >
                {item.icon}
                <span className="menu-label">{labelOf(item)}</span>
                {status === 'locked' && edition === 'community' ? <span className="menu-tag">{LOCK_TOOLTIP}</span> : null}
                {status === 'locked' && item.lock === true ? <span className="icon icon-lock" aria-hidden="true" /> : null}
                {opensSubmenu ? <span className="icon icon-chevron" aria-hidden="true" /> : null}
                {item.shortcut === undefined || opensSubmenu ? null : (
                  <span className="menu-hint" aria-hidden="true">
                    {item.shortcut}
                  </span>
                )}
              </button>
            </Fragment>
          );
        })}
      </div>
      {activeSubmenu === undefined ? null : (
        <Submenu item={activeSubmenu.item} row={activeSubmenu.row} takeFocus={activeSubmenu.takeFocus} context={contextNow()} close={() => setSubmenuOpen(undefined)} closeAll={() => closeMenu(true)} />
      )}
    </div>
  );
}
